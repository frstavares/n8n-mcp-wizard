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

/**
 * True for the default key and any legacy per-instance key (n8n, n8n-acme, …),
 * so uninstall can sweep up servers left by older versions of the wizard.
 */
export function isN8nServerKey(key: string): boolean {
  return key === DEFAULT_SERVER_KEY || key.startsWith(`${DEFAULT_SERVER_KEY}-`);
}
