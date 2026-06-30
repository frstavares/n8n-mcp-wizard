import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  authorize,
  generatePkce,
  generateState,
  parseCallback,
} from '../src/lib/auth/oauth.js';
import { WizardError } from '../src/lib/errors.js';

const BASE = 'https://acme.app.n8n.cloud';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fetch double that fails discovery (forcing fallback paths), skips DCR, and
 * returns a token. `onAuthorize` receives the parsed authorize-URL params from
 * the (separate) authorize-URL inspection.
 */
function makeFetch(opts: {
  token?: Record<string, unknown>;
  tokenStatus?: number;
  onTokenBody?: (body: URLSearchParams) => void;
} = {}): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/.well-known/')) {
      // No discovery -> fall back to conventional paths.
      return new Response('not found', { status: 404 });
    }
    if (url.endsWith('/mcp-oauth/register')) {
      // No DCR available.
      return new Response('not found', { status: 404 });
    }
    if (url.endsWith('/mcp-oauth/token')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      opts.onTokenBody?.(body);
      const payload = opts.token ?? {
        access_token: 'tok_123',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'ref_456',
      };
      return new Response(JSON.stringify(payload), {
        status: opts.tokenStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('unexpected', { status: 500 });
  };
  return impl as unknown as typeof fetch;
}

describe('generatePkce', () => {
  it('produces a verifier in the 43–128 char range and a matching S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // base64url alphabet only (no +, /, or =).
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // The challenge must be S256(verifier).
    const expected = base64url(createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it('generates a fresh pair each call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe('parseCallback', () => {
  it('extracts code and state from a full redirect URL', () => {
    const r = parseCallback('http://localhost:8237/callback?code=abc&state=xyz');
    expect(r).toEqual({ code: 'abc', state: 'xyz', error: undefined });
  });

  it('extracts from a bare query string', () => {
    expect(parseCallback('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz', error: undefined });
  });

  it('treats a bare value as the code', () => {
    expect(parseCallback('  rawcode  ')).toEqual({ code: 'rawcode' });
  });

  it('surfaces an error param', () => {
    expect(parseCallback('http://localhost/callback?error=access_denied').error).toBe('access_denied');
  });
});

describe('authorize — state mismatch', () => {
  it('rejects with OAUTH_FAILED when the pasted state does not match', async () => {
    const openedUrls: string[] = [];
    let authorizeState = '';

    const promise = authorize(BASE, {
      fetchImpl: makeFetch(),
      ports: [8551, 8552],
      timeoutMs: 5000,
      openBrowser: async (url) => {
        openedUrls.push(url);
        authorizeState = new URL(url).searchParams.get('state') ?? '';
      },
      // Paste a callback whose state is deliberately wrong.
      onManualCode: async () => {
        // Give openBrowser a tick to record the real state first.
        await new Promise((r) => setTimeout(r, 10));
        expect(authorizeState).not.toBe('');
        return `http://localhost:8551/callback?code=abc&state=WRONG_${authorizeState}`;
      },
    });

    await expect(promise).rejects.toBeInstanceOf(WizardError);
    await expect(promise).rejects.toMatchObject({ code: 'OAUTH_FAILED' });
    expect(openedUrls).toHaveLength(1);
  });
});

describe('authorize — happy path via manual paste', () => {
  it('exchanges the code and returns tokens (PKCE verifier sent)', async () => {
    let sentVerifier: string | null = null;
    let authorizeUrl = '';

    const result = await authorize(BASE, {
      fetchImpl: makeFetch({
        onTokenBody: (body) => {
          sentVerifier = body.get('code_verifier');
          expect(body.get('grant_type')).toBe('authorization_code');
          expect(body.get('code')).toBe('thecode');
        },
      }),
      ports: [8553, 8554],
      timeoutMs: 5000,
      onUrl: (url) => {
        authorizeUrl = url;
      },
      openBrowser: async () => undefined,
      onManualCode: async () => {
        const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
        return `http://localhost:8553/callback?code=thecode&state=${state}`;
      },
    });

    expect(result).toEqual({
      accessToken: 'tok_123',
      refreshToken: 'ref_456',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    expect(sentVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    // The authorize URL must carry the PKCE challenge + S256 method.
    const params = new URL(authorizeUrl).searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBeTruthy();
    expect(params.get('redirect_uri')).toBe('http://localhost:8553/callback');
  });

  it('throws OAUTH_FAILED when the token endpoint rejects', async () => {
    let authorizeUrl = '';
    const promise = authorize(BASE, {
      fetchImpl: makeFetch({
        tokenStatus: 400,
        token: { error: 'invalid_grant', error_description: 'expired' },
      }),
      ports: [8555, 8556],
      timeoutMs: 5000,
      onUrl: (url) => {
        authorizeUrl = url;
      },
      openBrowser: async () => undefined,
      onManualCode: async () => {
        const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
        return `http://localhost:8555/callback?code=thecode&state=${state}`;
      },
    });
    await expect(promise).rejects.toMatchObject({ code: 'OAUTH_FAILED' });
  });
});

describe('generateState', () => {
  it('is url-safe and unique', () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});
