export type ClientId = 'claude-code' | 'cursor' | 'claude-desktop' | 'vscode' | 'codex' | 'zed';

export interface WriteContext {
  mcpUrl: string;
  /** Present = API-key fan-out (Bearer written into config). Absent = OAuth mode (URL only). */
  apiKey?: string;
  /** Server key written into the client config. */
  serverKey?: string;
}

export interface ClientWriteResult {
  id: ClientId;
  label: string;
  ok: boolean;
  /** e.g. 'user' / 'project' / 'cli-managed' — never the absolute path. */
  pathKind?: string;
  detail?: string;
  /** Set when ok=false. */
  error?: string;
  /** Copy-paste fallback shown when the write fails or as a manual option. */
  manual?: string;
}

export interface ClientDef {
  id: ClientId;
  label: string;
  /** Pre-checked by default? Browser connectors (claude.ai) are offered but opt-in. */
  autoSelect?: boolean;
  /** True if the client appears installed / available on this machine. */
  detect(): Promise<boolean>;
  write(ctx: WriteContext, opts?: { overwrite?: boolean }): Promise<ClientWriteResult>;
  /** Remove the n8n MCP server entry from this client (uninstall). */
  remove(serverKey?: string): Promise<ClientWriteResult>;
  /** A copy-paste config snippet the user can apply by hand. */
  manualHint(ctx: WriteContext): string;
}

export const DEFAULT_SERVER_KEY = 'n8n';

/** True for the default key and any per-instance key we generate (n8n, n8n-acme, …). */
export function isN8nServerKey(key: string): boolean {
  return key === DEFAULT_SERVER_KEY || key.startsWith(`${DEFAULT_SERVER_KEY}-`);
}

/**
 * Derive a per-instance MCP server key from the instance URL, so several n8n
 * instances can coexist in one client's config and the user can tell them apart
 * in their tool's server list. n8n Cloud is shortened to its subdomain
 * (acme.app.n8n.cloud → n8n-acme); everything else uses the full host slug
 * (n8n.acme.com → n8n-acme-com, localhost:5678 → n8n-localhost-5678). The result
 * is always [a-z0-9-], so it's safe as a Codex TOML table name and a CLI arg.
 */
export function serverKeyForInstance(instanceBaseUrl: string): string {
  let host: string;
  let port = '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(instanceBaseUrl) ? instanceBaseUrl : `https://${instanceBaseUrl}`);
    host = u.hostname;
    port = u.port;
  } catch {
    return DEFAULT_SERVER_KEY;
  }
  // n8n Cloud → just the subdomain (acme.app.n8n.cloud / acme.n8n.cloud → acme).
  const cloud = host.match(/^([^.]+)\.(?:app\.)?n8n\.cloud$/i);
  const base = cloud?.[1] ?? host;
  let slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (port) slug = slug ? `${slug}-${port}` : port;
  if (!slug) return DEFAULT_SERVER_KEY;
  return /^n8n(-|$)/.test(slug) ? slug : `${DEFAULT_SERVER_KEY}-${slug}`;
}
