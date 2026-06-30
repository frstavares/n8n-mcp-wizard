/**
 * Browser-based OAuth 2.0 (Authorization Code + PKCE) for an n8n instance's
 * MCP server. Spins up a localhost callback server, opens the browser, and
 * exchanges the returned code for an access token.
 *
 * n8n's MCP server speaks standard OAuth 2.1: a discovery document advertises
 * the authorize/token/registration endpoints, Dynamic Client Registration
 * mints a public client, and PKCE (S256) protects the code exchange. We prefer
 * the discovery document at runtime and only fall back to the conventional
 * `/mcp-oauth/*` paths if discovery is unreachable.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { WizardError } from '../errors.js';

export interface OAuthResult {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
}

export interface AuthorizeOptions {
  fetchImpl?: typeof fetch;
  /** Open a URL in the user's browser. Defaults to dynamic `import('open')`. */
  openBrowser?: (url: string) => Promise<unknown>;
  /** Localhost callback ports to try, in order. Default [8237,8238,8239,8240]. */
  ports?: number[];
  /** Overall deadline for the flow. Default 300_000 (5 min). */
  timeoutMs?: number;
  /** Called with the authorize URL (so the UI can show "opening browser…"). */
  onUrl?: (url: string) => void;
  /**
   * Optional manual fallback. If provided, it races the local callback: resolve
   * with the full pasted callback URL (or a bare `code`) and we'll use that.
   */
  onManualCode?: () => Promise<string>;
}

type FetchLike = typeof fetch;

const DEFAULT_PORTS = [8237, 8238, 8239, 8240];
const DEFAULT_TIMEOUT_MS = 300_000;
const CALLBACK_PATH = '/callback';
const CLIENT_NAME = 'n8n MCP CLI';
/** Requested scopes. The server intersects these with what it supports. */
const SCOPES = 'tool:listWorkflows tool:getWorkflowDetails';

interface DiscoveryDoc {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

interface Endpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope: string;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/** PKCE pair: a high-entropy verifier and its S256 challenge. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** base64url-encode a buffer (no padding) per RFC 7636. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a PKCE code_verifier + S256 code_challenge using node:crypto. */
export function generatePkce(): PkcePair {
  // 32 random bytes -> 43-char base64url verifier (within the 43–128 range).
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** A URL-safe opaque value for the OAuth `state` parameter. */
export function generateState(): string {
  return base64url(randomBytes(16));
}

/**
 * Pull `code` (and `state`) out of a callback. Accepts a full redirect URL
 * (`http://localhost:8237/callback?code=…&state=…`), a bare query string, or a
 * bare code. Used by both the local server and the manual-paste fallback.
 */
export function parseCallback(input: string): { code?: string; state?: string; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) return {};
  // Try to interpret as a URL or query string first.
  let params: URLSearchParams | undefined;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      params = new URL(trimmed).searchParams;
    } catch {
      params = undefined;
    }
  } else if (trimmed.includes('=')) {
    params = new URLSearchParams(trimmed.replace(/^\?/, ''));
  }
  if (params) {
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
      error: params.get('error') ?? undefined,
    };
  }
  // Otherwise treat the whole thing as a bare authorization code.
  return { code: trimmed };
}

function oauthError(message: string, context?: Record<string, unknown>): WizardError {
  return new WizardError('OAUTH_FAILED', message, {
    suggestion: 'Try again, or use --api-key instead.',
    context,
  });
}

/**
 * Fetch the OAuth discovery document, falling back to the conventional
 * `/mcp-oauth/*` paths if it is unavailable or incomplete.
 */
async function discoverEndpoints(instanceBaseUrl: string, fetchImpl: FetchLike): Promise<Endpoints> {
  const fallback: Endpoints = {
    authorizationEndpoint: `${instanceBaseUrl}/mcp-oauth/authorize`,
    tokenEndpoint: `${instanceBaseUrl}/mcp-oauth/token`,
    registrationEndpoint: `${instanceBaseUrl}/mcp-oauth/register`,
    scope: SCOPES,
  };
  try {
    const res = await fetchImpl(`${instanceBaseUrl}/.well-known/oauth-authorization-server`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return fallback;
    const doc = (await res.json()) as DiscoveryDoc;
    return {
      authorizationEndpoint: doc.authorization_endpoint ?? fallback.authorizationEndpoint,
      tokenEndpoint: doc.token_endpoint ?? fallback.tokenEndpoint,
      registrationEndpoint: doc.registration_endpoint ?? fallback.registrationEndpoint,
      scope:
        Array.isArray(doc.scopes_supported) && doc.scopes_supported.length > 0
          ? doc.scopes_supported.join(' ')
          : fallback.scope,
    };
  } catch {
    return fallback;
  }
}

/**
 * Dynamic Client Registration for a public client. Returns the issued
 * `client_id`, or `undefined` if DCR isn't available (the server may then
 * accept an unregistered public client).
 */
async function registerClient(
  endpoints: Endpoints,
  redirectUri: string,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  if (!endpoints.registrationEndpoint) return undefined;
  try {
    const res = await fetchImpl(endpoints.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // Public client: no secret, PKCE-only.
        token_endpoint_auth_method: 'none',
        scope: endpoints.scope,
      }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { client_id?: string };
    return body.client_id;
  } catch {
    return undefined;
  }
}

/** Try to listen on the first free port from the list. */
async function listenOnFreePort(
  ports: number[],
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  let lastErr: unknown;
  for (const port of ports) {
    try {
      const server = createServer(handler);
      await new Promise<void>((resolve, reject) => {
        const onError = (err: unknown) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return { server, port };
    } catch (err) {
      lastErr = err;
    }
  }
  throw oauthError(
    `Could not bind a localhost callback port (tried ${ports.join(', ')}).`,
    { ports, cause: lastErr instanceof Error ? lastErr.message : String(lastErr) },
  );
}

/**
 * The n8n logo lockup, inline so the page makes no external requests.
 * Both marks are the design-system source vectors:
 *   - the coral "8" icon  (#EA4B71) — N8nLogo/logo-icon.svg
 *   - the "n…n" wordmark  (#101330) — N8nLogo/logo-text.svg
 * Sizes are scaled up ~1.85x from the 32x26 / 26x26 source viewports.
 */
const N8N_LOGO = `<svg class="logo-icon" width="59" height="48" viewBox="0 0 32 26" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill-rule="evenodd" clip-rule="evenodd" d="M27.2 11.3955C26.4903 11.3959 25.8006 11.1603 25.2394 10.7259C24.6783 10.2914 24.2774 9.68271 24.1 8.99555H20.433C20.0543 8.9956 19.6879 9.12999 19.3989 9.3748C19.11 9.61962 18.9173 9.95899 18.855 10.3325L18.723 11.1225C18.6018 11.8478 18.2346 12.5092 17.683 12.9955C18.2348 13.4821 18.6021 14.1439 18.723 14.8695L18.855 15.6585C18.9173 16.0321 19.11 16.3715 19.3989 16.6163C19.6879 16.8611 20.0543 16.9955 20.433 16.9955H20.901C21.0968 16.2424 21.5603 15.5864 22.2047 15.1502C22.8491 14.714 23.6303 14.5275 24.4023 14.6255C25.1743 14.7236 25.8841 15.0995 26.399 15.6829C26.9139 16.2663 27.1987 17.0174 27.2 17.7955C27.2015 18.5755 26.9182 19.3292 26.4031 19.9149C25.8881 20.5006 25.1769 20.8781 24.4031 20.9764C23.6294 21.0746 22.8464 20.8869 22.2013 20.4485C21.5562 20.0101 21.0935 19.3511 20.9 18.5955H20.433C19.6756 18.5954 18.9428 18.3267 18.3649 17.837C17.787 17.3474 17.4015 16.6687 17.277 15.9215L17.145 15.1325C17.0828 14.759 16.89 14.4196 16.6011 14.1748C16.3121 13.93 15.9457 13.7956 15.567 13.7955H14.299C14.1214 14.4823 13.7206 15.0907 13.1596 15.525C12.5987 15.9593 11.9094 16.1949 11.2 16.1949C10.4906 16.1949 9.80129 15.9593 9.24036 15.525C8.67943 15.0907 8.27866 14.4823 8.10101 13.7955H6.29901C6.1032 14.5487 5.63975 15.2047 4.99533 15.6409C4.35091 16.0771 3.56967 16.2636 2.7977 16.1656C2.02573 16.0675 1.31592 15.6916 0.800999 15.1082C0.286083 14.5247 0.00133389 13.7737 6.20563e-06 12.9955C-0.00152906 12.2156 0.281849 11.4619 0.796882 10.8762C1.31191 10.2905 2.02314 9.91299 2.79689 9.81474C3.57064 9.71649 4.35363 9.90421 4.99871 10.3426C5.6438 10.781 6.10655 11.44 6.30001 12.1955H8.10001C8.27697 11.5079 8.67758 10.8985 9.23878 10.4635C9.79998 10.0284 10.4899 9.79229 11.2 9.79229C11.9101 9.79229 12.6 10.0284 13.1612 10.4635C13.7224 10.8985 14.123 11.5079 14.3 12.1955H15.567C15.9457 12.1955 16.3121 12.0611 16.6011 11.8163C16.89 11.5715 17.0828 11.2321 17.145 10.8585L17.277 10.0685C17.4017 9.32161 17.7873 8.64311 18.3652 8.15368C18.943 7.66425 19.6757 7.39562 20.433 7.39555H24.101C24.2968 6.64242 24.7603 5.9864 25.4047 5.5502C26.0491 5.114 26.8303 4.92747 27.6023 5.02552C28.3743 5.12356 29.0841 5.49945 29.599 6.0829C30.1139 6.66634 30.3987 7.41738 30.4 8.19555C30.4 9.04424 30.0629 9.85817 29.4627 10.4583C28.8626 11.0584 28.0487 11.3955 27.2 11.3955ZM27.2 9.79555C27.6244 9.79555 28.0313 9.62698 28.3314 9.32692C28.6314 9.02686 28.8 8.61989 28.8 8.19555C28.8 7.7712 28.6314 7.36423 28.3314 7.06418C28.0313 6.76412 27.6244 6.59555 27.2 6.59555C26.7757 6.59555 26.3687 6.76412 26.0686 7.06418C25.7686 7.36423 25.6 7.7712 25.6 8.19555C25.6 8.61989 25.7686 9.02686 26.0686 9.32692C26.3687 9.62698 26.7757 9.79555 27.2 9.79555ZM3.20001 14.5955C3.62435 14.5955 4.03132 14.427 4.33138 14.1269C4.63144 13.8269 4.80001 13.4199 4.80001 12.9955C4.80001 12.5712 4.63144 12.1642 4.33138 11.8642C4.03132 11.5641 3.62435 11.3955 3.20001 11.3955C2.77566 11.3955 2.36869 11.5641 2.06864 11.8642C1.76858 12.1642 1.60001 12.5712 1.60001 12.9955C1.60001 13.4199 1.76858 13.8269 2.06864 14.1269C2.36869 14.427 2.77566 14.5955 3.20001 14.5955ZM12.8 12.9955C12.8 13.2057 12.7586 13.4137 12.6782 13.6078C12.5978 13.802 12.48 13.9783 12.3314 14.1269C12.1828 14.2755 12.0064 14.3933 11.8123 14.4738C11.6182 14.5542 11.4101 14.5955 11.2 14.5955C10.9899 14.5955 10.7818 14.5542 10.5877 14.4738C10.3936 14.3933 10.2172 14.2755 10.0686 14.1269C9.92006 13.9783 9.80221 13.802 9.7218 13.6078C9.64139 13.4137 9.60001 13.2057 9.60001 12.9955C9.60001 12.5712 9.76858 12.1642 10.0686 11.8642C10.3687 11.5641 10.7757 11.3955 11.2 11.3955C11.6244 11.3955 12.0313 11.5641 12.3314 11.8642C12.6314 12.1642 12.8 12.5712 12.8 12.9955ZM25.6 17.7955C25.6 18.0057 25.5586 18.2137 25.4782 18.4078C25.3978 18.602 25.28 18.7783 25.1314 18.9269C24.9828 19.0755 24.8064 19.1933 24.6123 19.2738C24.4182 19.3542 24.2101 19.3955 24 19.3955C23.7899 19.3955 23.5818 19.3542 23.3877 19.2738C23.1936 19.1933 23.0172 19.0755 22.8686 18.9269C22.7201 18.7783 22.6022 18.602 22.5218 18.4078C22.4414 18.2137 22.4 18.0057 22.4 17.7955C22.4 17.3712 22.5686 16.9642 22.8686 16.6642C23.1687 16.3641 23.5757 16.1955 24 16.1955C24.4244 16.1955 24.8313 16.3641 25.1314 16.6642C25.4314 16.9642 25.6 17.3712 25.6 17.7955Z" fill="#EA4B71"/></svg><svg class="logo-text" width="48" height="48" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill-rule="evenodd" clip-rule="evenodd" d="M15.002 12.99V12.914C15.56 12.634 16.118 12.152 16.118 11.198C16.118 9.826 14.988 9 13.428 9C11.83 9 10.688 9.877 10.688 11.224C10.688 12.139 11.221 12.634 11.804 12.914V12.99C11.383 13.1435 11.0201 13.4241 10.7656 13.7931C10.5112 14.162 10.3778 14.6009 10.384 15.049C10.384 16.434 11.525 17.4 13.416 17.4C15.306 17.4 16.41 16.434 16.41 15.049C16.417 14.6023 16.2854 14.1645 16.0332 13.7957C15.7811 13.427 15.4208 13.1455 15.002 12.99ZM13.415 10.17C14.05 10.17 14.519 10.576 14.519 11.262C14.519 11.948 14.037 12.355 13.416 12.355C12.794 12.355 12.274 11.948 12.274 11.262C12.274 10.563 12.769 10.169 13.416 10.169M13.416 16.179C12.681 16.179 12.084 15.709 12.084 14.909C12.084 14.184 12.579 13.637 13.404 13.637C14.216 13.637 14.711 14.171 14.711 14.934C14.711 15.709 14.139 16.179 13.416 16.179Z" fill="#101330"/><path d="M18.3672 17.272H19.9912V13.83C19.9912 12.699 20.6762 12.203 21.4512 12.203C22.2112 12.203 22.8082 12.712 22.8082 13.753V17.273H24.4322V13.422C24.4322 11.758 23.4682 10.792 21.9582 10.792C21.0062 10.792 20.4732 11.173 20.0932 11.669H19.9912L19.8512 10.919H18.3672V17.272ZM3.99119 17.272H2.36719V10.92H3.85219L3.99219 11.67H4.09219C4.47319 11.174 5.00619 10.793 5.95819 10.793C7.46819 10.793 8.43219 11.759 8.43219 13.423V17.273H6.80819V13.752C6.80819 12.711 6.21219 12.202 5.45019 12.202C4.67619 12.202 3.99119 12.698 3.99119 13.829V17.272Z" fill="#101330"/></svg>`;

/**
 * Build a self-contained, n8n-branded callback page. No external requests —
 * inline SVG logo, inline CSS, n8n's design-system colors and Inter-led font
 * stack (system fallback). `variant` switches the accent + iconography between
 * the success and error states.
 *
 * Brand tokens (n8n design-system, OKLCH source resolved to sRGB hex):
 *   primary  #FF6900 (--color--orange-500)   danger #E7000B (--color--red-600)
 *   success  #00A63E (--color--green-600)     text   #262626 (--color--neutral-900)
 *   muted    #737373                          bg     #F5F5F5 (--color--neutral-125)
 *   surface  #FFFFFF                          border #E5E5E5 (--color--neutral-200)
 */
function renderCallbackPage(variant: 'success' | 'error', headline: string, body: string): string {
  const isError = variant === 'error';
  const accent = isError ? '#E7000B' : '#00A63E';
  const accentSoft = isError ? '#FDECEC' : '#E7F8EE';
  const glyph = isError
    ? // exclamation-in-circle
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7.5v5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.4" r="1.15" fill="currentColor"/></svg>'
    : // checkmark-in-circle
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M8.25 12.25l2.6 2.6 5-5.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>n8n &mdash; ${isError ? 'Connection failed' : 'Connected'}</title>
<style>
  :root {
    --brand: #FF6900;
    --accent: ${accent};
    --accent-soft: ${accentSoft};
    --text: #262626;
    --muted: #737373;
    --surface: #FFFFFF;
    --bg: #F5F5F5;
    --border: #E5E5E5;
    --font: 'InterVariable', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    --font-mono: CommitMono, ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
    font-family: var(--font);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    background: var(--bg);
    background-image:
      radial-gradient(900px 480px at 50% -160px, rgba(255, 105, 0, 0.10), transparent 70%),
      radial-gradient(circle at 1px 1px, rgba(38, 38, 38, 0.045) 1px, transparent 0);
    background-size: auto, 22px 22px;
  }
  .card {
    width: 100%;
    max-width: 416px;
    padding: 40px 40px 32px;
    text-align: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 1px 2px rgba(16, 19, 48, 0.04), 0 12px 32px -12px rgba(16, 19, 48, 0.18);
    animation: rise 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-bottom: 28px;
  }
  .brand svg { display: block; height: 30px; width: auto; }
  .status {
    width: 56px;
    height: 56px;
    margin: 0 auto 20px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    color: var(--accent);
    background: var(--accent-soft);
  }
  .status svg { display: block; }
  h1 {
    font-size: 21px;
    line-height: 1.25;
    letter-spacing: -0.01em;
    font-weight: 600;
    margin: 0 0 10px;
  }
  p {
    margin: 0;
    color: var(--muted);
    font-size: 15px;
    line-height: 1.6;
  }
  .terminal {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.9em;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  .note {
    margin-top: 24px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .card { animation: none; }
  }
</style>
</head>
<body>
  <main class="card">
    <span class="brand">${N8N_LOGO}</span>
    <div class="status">${glyph}</div>
    <h1>${headline}</h1>
    <p>${body}</p>
  </main>
</body>
</html>`;
}

const SUCCESS_HTML = renderCallbackPage(
  'success',
  'Connected to n8n',
  'You’re all set. You can close this tab and return to your <span class="terminal">terminal</span>.',
);

/** Built lazily per error so the message can be tailored to the failure. */
function errorHtml(detail: string): string {
  return renderCallbackPage(
    'error',
    'Connection failed',
    `${detail} Return to your <span class="terminal">terminal</span> to try again.`,
  );
}

/**
 * Run the localhost callback server and resolve with the authorization code
 * once the browser redirects back. Verifies `state`. Serves a branded page.
 */
function waitForCallback(
  server: Server,
  expectedState: string,
): Promise<{ code: string }> {
  return new Promise<{ code: string }>((resolve, reject) => {
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      const { code, state, error } = parseCallback(url.search);
      const errorHeaders = { 'content-type': 'text/html; charset=utf-8' };
      if (error) {
        res
          .writeHead(400, errorHeaders)
          .end(errorHtml('Authorization was denied.'));
        reject(oauthError(`Authorization was denied (${error}).`));
        return;
      }
      if (!state || state !== expectedState) {
        res
          .writeHead(400, errorHeaders)
          .end(errorHtml('The sign-in response could not be verified.'));
        reject(oauthError('OAuth state mismatch — possible CSRF, aborting.'));
        return;
      }
      if (!code) {
        res
          .writeHead(400, errorHeaders)
          .end(errorHtml('The sign-in response was missing an authorization code.'));
        reject(oauthError('Callback did not include an authorization code.'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML);
      resolve({ code });
    });
    server.on('error', (err) => reject(oauthError('Local callback server failed.', { cause: err.message })));
  });
}

/** Exchange an authorization code for tokens at the token endpoint. */
async function exchangeCode(
  endpoints: Endpoints,
  params: { code: string; redirectUri: string; codeVerifier: string; clientId?: string },
  fetchImpl: FetchLike,
): Promise<OAuthResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  if (params.clientId) body.set('client_id', params.clientId);

  let res: Response;
  try {
    res = await fetchImpl(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    throw oauthError('Could not reach the token endpoint.', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  let json: TokenResponse;
  try {
    json = (await res.json()) as TokenResponse;
  } catch {
    json = {};
  }

  if (!res.ok || json.error || !json.access_token) {
    const detail = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    throw oauthError(`Token exchange failed (${detail}).`, { status: res.status });
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenType: json.token_type ?? 'Bearer',
    expiresIn: json.expires_in,
  };
}

/** Lazy default browser opener (the `open` dep is ESM-only). */
async function defaultOpenBrowser(url: string): Promise<unknown> {
  const mod = await import('open');
  return mod.default(url);
}

/** Reject after `ms`, used to bound the overall flow. */
function timeout(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(oauthError(`Timed out after ${Math.round(ms / 1000)}s waiting for sign-in.`)), ms);
    // Don't keep the event loop alive solely for this timer.
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Run the full browser OAuth (PKCE) flow against an n8n instance and return the
 * issued tokens.
 *
 * @throws WizardError('OAUTH_FAILED') on any failure.
 */
export async function authorize(instanceBaseUrl: string, opts: AuthorizeOptions = {}): Promise<OAuthResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser;
  const ports = opts.ports && opts.ports.length > 0 ? opts.ports : DEFAULT_PORTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = instanceBaseUrl.replace(/\/$/, '');

  const endpoints = await discoverEndpoints(base, fetchImpl);
  const pkce = generatePkce();
  const state = generateState();

  // Start the callback server first so we know which port to register/redirect.
  const noop = () => {};
  const { server, port } = await listenOnFreePort(ports, noop);
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

  try {
    const clientId = await registerClient(endpoints, redirectUri, fetchImpl);

    const authorizeUrl = new URL(endpoints.authorizationEndpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    if (clientId) authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', endpoints.scope);
    authorizeUrl.searchParams.set('state', state);
    const authorizeUrlStr = authorizeUrl.toString();

    opts.onUrl?.(authorizeUrlStr);
    // Best-effort: never let a failed browser launch abort the flow.
    await Promise.resolve(openBrowser(authorizeUrlStr)).catch(() => undefined);

    const racers: Array<Promise<{ code: string }>> = [waitForCallback(server, state), timeout(timeoutMs)];

    if (opts.onManualCode) {
      racers.push(
        opts.onManualCode().then((pasted) => {
          const { code, state: pastedState, error } = parseCallback(pasted);
          if (error) throw oauthError(`Authorization was denied (${error}).`);
          // If a state came along with the paste, it must match.
          if (pastedState && pastedState !== state) {
            throw oauthError('OAuth state mismatch — possible CSRF, aborting.');
          }
          if (!code) throw oauthError('No authorization code found in the pasted value.');
          return { code };
        }),
      );
    }

    const { code } = await Promise.race(racers);

    return await exchangeCode(endpoints, { code, redirectUri, codeVerifier: pkce.verifier, clientId }, fetchImpl);
  } catch (err) {
    if (err instanceof WizardError) throw err;
    throw oauthError(err instanceof Error ? err.message : String(err));
  } finally {
    server.close();
  }
}
