import { describe, it, expect } from 'vitest';
import {
  normalizeInstanceUrl,
  detectInstanceType,
  probeInstance,
  mcpServerUrl,
} from '../src/lib/instance.js';
import { WizardError } from '../src/lib/errors.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Build a fake fetch that returns a Response with the given status. */
function fetchReturning(status: number): FetchLike {
  return async () => new Response(null, { status });
}

/** Build a fake fetch that throws (simulating a network failure). */
function fetchThrowing(): FetchLike {
  return async () => {
    throw new Error('network down');
  };
}

describe('normalizeInstanceUrl', () => {
  it('adds https:// to a bare host', () => {
    expect(normalizeInstanceUrl('acme.app.n8n.cloud')).toBe('https://acme.app.n8n.cloud');
  });

  it('preserves an explicit http:// scheme', () => {
    expect(normalizeInstanceUrl('http://n8n.example.com')).toBe('http://n8n.example.com');
  });

  it('strips a trailing slash', () => {
    expect(normalizeInstanceUrl('https://n8n.example.com/')).toBe('https://n8n.example.com');
  });

  it('preserves a subpath (and strips its trailing slash)', () => {
    expect(normalizeInstanceUrl('https://example.com/n8n/')).toBe('https://example.com/n8n');
    expect(normalizeInstanceUrl('example.com/n8n')).toBe('https://example.com/n8n');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeInstanceUrl('  acme.app.n8n.cloud  ')).toBe('https://acme.app.n8n.cloud');
  });

  it('throws WizardError(INVALID_URL) on empty input', () => {
    try {
      normalizeInstanceUrl('');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WizardError);
      expect((e as WizardError).code).toBe('INVALID_URL');
    }
  });

  it('throws WizardError(INVALID_URL) on whitespace-only input', () => {
    expect(() => normalizeInstanceUrl('   ')).toThrowError(WizardError);
  });

  it('throws WizardError(INVALID_URL) on garbage input', () => {
    // A space makes the synthesized https://not a url URL invalid.
    try {
      normalizeInstanceUrl('not a url');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WizardError);
      expect((e as WizardError).code).toBe('INVALID_URL');
    }
  });

  it('throws WizardError(INVALID_URL) on a bare scheme with no host', () => {
    expect(() => normalizeInstanceUrl('http://')).toThrowError(WizardError);
  });
});

describe('mcpServerUrl', () => {
  it('appends the MCP server path', () => {
    expect(mcpServerUrl('https://acme.app.n8n.cloud')).toBe(
      'https://acme.app.n8n.cloud/mcp-server/http',
    );
  });
});

describe('detectInstanceType', () => {
  it('detects n8n cloud hosts', () => {
    expect(detectInstanceType('https://acme.app.n8n.cloud')).toBe('cloud');
    expect(detectInstanceType('https://foo.n8n.cloud')).toBe('cloud');
  });

  it('detects localhost / loopback as self-hosted', () => {
    expect(detectInstanceType('http://localhost:5678')).toBe('self-hosted');
    expect(detectInstanceType('http://127.0.0.1:5678')).toBe('self-hosted');
    expect(detectInstanceType('http://0.0.0.0:5678')).toBe('self-hosted');
  });

  it('detects private network ranges as self-hosted', () => {
    expect(detectInstanceType('http://10.0.0.5')).toBe('self-hosted');
    expect(detectInstanceType('http://192.168.1.10')).toBe('self-hosted');
    expect(detectInstanceType('http://172.16.0.1')).toBe('self-hosted');
    expect(detectInstanceType('http://172.31.255.255')).toBe('self-hosted');
    expect(detectInstanceType('http://n8n.local')).toBe('self-hosted');
  });

  it('treats a public custom domain as unknown', () => {
    expect(detectInstanceType('https://n8n.example.com')).toBe('unknown');
  });

  it('returns unknown for an unparseable URL', () => {
    expect(detectInstanceType('::::not a url::::')).toBe('unknown');
  });

  it('does not classify 172.x outside the private range as self-hosted', () => {
    // 172.15 and 172.32 are outside 172.16-172.31.
    expect(detectInstanceType('http://172.15.0.1')).toBe('unknown');
    expect(detectInstanceType('http://172.32.0.1')).toBe('unknown');
  });
});

describe('probeInstance', () => {
  it('treats 401 as reachable + mcpEnabled', async () => {
    const res = await probeInstance('https://acme.app.n8n.cloud', {
      fetchImpl: fetchReturning(401),
    });
    expect(res.reachable).toBe(true);
    expect(res.mcpEnabled).toBe(true);
    expect(res.status).toBe(401);
    expect(res.instanceType).toBe('cloud');
  });

  it('treats 403 as reachable but mcp disabled', async () => {
    const res = await probeInstance('https://n8n.example.com', {
      fetchImpl: fetchReturning(403),
    });
    expect(res.reachable).toBe(true);
    expect(res.mcpEnabled).toBe(false);
    expect(res.status).toBe(403);
  });

  it('treats 404 as reachable but mcp disabled', async () => {
    const res = await probeInstance('https://n8n.example.com', {
      fetchImpl: fetchReturning(404),
    });
    expect(res.reachable).toBe(true);
    expect(res.mcpEnabled).toBe(false);
    expect(res.status).toBe(404);
  });

  it('treats 2xx as reachable + mcpEnabled', async () => {
    const res = await probeInstance('https://n8n.example.com', {
      fetchImpl: fetchReturning(200),
    });
    expect(res.reachable).toBe(true);
    expect(res.mcpEnabled).toBe(true);
    expect(res.status).toBe(200);
  });

  it('treats a thrown (network) error as unreachable', async () => {
    const res = await probeInstance('https://n8n.example.com', {
      fetchImpl: fetchThrowing(),
    });
    expect(res.reachable).toBe(false);
    expect(res.mcpEnabled).toBe(false);
    // No status when the request never completed.
    expect(res.status).toBeUndefined();
  });

  it('calls fetch against the MCP server URL with a HEAD request', async () => {
    let seenUrl: string | undefined;
    let seenMethod: string | undefined;
    const res = await probeInstance('https://acme.app.n8n.cloud', {
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenMethod = init?.method;
        return new Response(null, { status: 401 });
      },
    });
    expect(seenUrl).toBe('https://acme.app.n8n.cloud/mcp-server/http');
    expect(seenMethod).toBe('HEAD');
    expect(res.mcpEnabled).toBe(true);
  });
});
