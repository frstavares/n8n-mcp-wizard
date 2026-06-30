import { WizardError } from './errors.js';

export type InstanceType = 'cloud' | 'self-hosted' | 'unknown';

export interface ProbeResult {
  reachable: boolean;
  /** True only when the MCP server endpoint is enabled (returns auth challenge). */
  mcpEnabled: boolean;
  status?: number;
  instanceType: InstanceType;
}

/**
 * Normalize raw user input into a clean instance base URL.
 * Adds https:// if missing, validates, strips a trailing slash.
 * Preserves a sub-path (for instances mounted behind one).
 * @throws WizardError INVALID_URL
 */
export function normalizeInstanceUrl(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new WizardError('INVALID_URL', 'No instance URL provided.', {
      suggestion: 'Pass your n8n URL, e.g. npx @n8n/mcp acme.app.n8n.cloud',
    });
  }
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    throw new WizardError('INVALID_URL', `"${input}" is not a valid URL.`, {
      suggestion: 'Use a host like acme.app.n8n.cloud or https://n8n.example.com',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WizardError('INVALID_URL', `Unsupported protocol "${url.protocol}".`, {
      suggestion: 'Use an http(s) URL.',
    });
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.origin}${path}`;
}

/** The MCP server endpoint for a (normalized) instance base URL. */
export function mcpServerUrl(instanceBaseUrl: string): string {
  return `${instanceBaseUrl}/mcp-server/http`;
}

export function detectInstanceType(instanceBaseUrl: string): InstanceType {
  let host: string;
  try {
    host = new URL(instanceBaseUrl).hostname;
  } catch {
    return 'unknown';
  }
  if (host.endsWith('.n8n.cloud')) return 'cloud';
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local')
  ) {
    return 'self-hosted';
  }
  return 'unknown';
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Probe an instance: is it reachable, and is the MCP server enabled?
 *
 * n8n returns 401 (WWW-Authenticate: Bearer) when MCP is enabled-but-unauthed,
 * and 403 ("MCP access is disabled") or 404 when it is disabled / absent.
 */
export async function probeInstance(
  instanceBaseUrl: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const instanceType = detectInstanceType(instanceBaseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(mcpServerUrl(instanceBaseUrl), {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual',
    });
    return { ...interpretStatus(res.status), status: res.status, instanceType };
  } catch {
    return { reachable: false, mcpEnabled: false, instanceType };
  } finally {
    clearTimeout(timer);
  }
}

function interpretStatus(status: number): { reachable: boolean; mcpEnabled: boolean } {
  // 401 = enabled, needs auth (the happy "ready to connect" signal).
  if (status === 401) return { reachable: true, mcpEnabled: true };
  // 403 (disabled) / 404 (endpoint absent) = reachable but MCP off.
  if (status === 403 || status === 404) return { reachable: true, mcpEnabled: false };
  // 2xx = reachable & responding (treat as enabled).
  if (status >= 200 && status < 300) return { reachable: true, mcpEnabled: true };
  // Anything else: reachable, but we can't confirm MCP is on.
  return { reachable: true, mcpEnabled: false };
}
