export type ClientId = 'claude-code' | 'cursor' | 'claude-desktop' | 'vscode' | 'codex' | 'zed' | 'claude-web';

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
  /** A copy-paste config snippet the user can apply by hand. */
  manualHint(ctx: WriteContext): string;
}

export const DEFAULT_SERVER_KEY = 'n8n';
