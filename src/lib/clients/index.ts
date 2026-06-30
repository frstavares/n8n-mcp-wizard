import { claudeCode } from './claude-code.js';
import { claudeDesktop } from './claude-desktop.js';
import { cursor } from './cursor.js';
import { vscode } from './vscode.js';
import type { ClientDef, ClientId, ClientWriteResult, WriteContext } from './types.js';

export * from './types.js';

/** All supported clients, in display order. */
export const ALL_CLIENTS: ClientDef[] = [claudeCode, cursor, claudeDesktop, vscode];

export function getClient(id: ClientId): ClientDef | undefined {
  return ALL_CLIENTS.find((c) => c.id === id);
}

/** A generic copy-paste config snippet, for when no client is detected. */
export function manualSnippet(ctx: WriteContext): string {
  return cursor.manualHint(ctx);
}

/**
 * Onboarding hint shown on the Done step: how to actually start using each
 * configured client (and, in OAuth mode, that first use triggers n8n login).
 */
export function clientUsage(id: ClientId, authMode: 'api-key' | 'oauth'): string {
  const login = authMode === 'oauth' ? ' First use opens n8n login in your browser.' : '';
  switch (id) {
    case 'claude-code':
      return `Run \`claude\` and ask: "What can you do with my n8n?"${login}`;
    case 'cursor':
      return `Open Cursor's Agent chat and mention n8n — the tools load automatically.${login}`;
    case 'claude-desktop':
      return `Restart Claude Desktop, then ask it about your n8n workflows.${login}`;
    case 'vscode':
      return `Open Copilot Chat (Agent mode) in VS Code; n8n tools appear under MCP.${login}`;
  }
}

/** Run detection across all clients; returns those that look installed. */
export async function detectClients(): Promise<ClientDef[]> {
  const results = await Promise.all(
    ALL_CLIENTS.map(async (c) => ({ c, installed: await c.detect().catch(() => false) })),
  );
  return results.filter((r) => r.installed).map((r) => r.c);
}

/**
 * Write config to each client. One failure never aborts the rest — each client
 * returns its own result (with a manual fallback snippet on failure).
 */
export async function configureClients(
  clients: ClientDef[],
  ctx: WriteContext,
  opts: { overwrite?: boolean } = {},
): Promise<ClientWriteResult[]> {
  const out: ClientWriteResult[] = [];
  for (const client of clients) {
    try {
      out.push(await client.write(ctx, opts));
    } catch (e) {
      out.push({
        id: client.id,
        label: client.label,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        manual: client.manualHint(ctx),
      });
    }
  }
  return out;
}
