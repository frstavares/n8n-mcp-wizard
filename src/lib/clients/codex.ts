import { execa } from 'execa';
import { commandExists } from '../util/command.js';
import { DEFAULT_SERVER_KEY, isN8nServerKey, type ClientDef, type ClientWriteResult, type WriteContext } from './types.js';

// NOTE: Codex CLI MCP flags are modeled on the PostHog wizard's usage and need a
// real-terminal check; manualHint is the safe fallback if a flag differs.
function codexArgs(ctx: WriteContext): string[] {
  const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
  const args = ['mcp', 'add', key, '--url', ctx.mcpUrl];
  if (ctx.apiKey) args.push('--bearer-token', ctx.apiKey);
  return args;
}

/** Names of n8n* MCP servers configured in Codex (`codex mcp list --json` → [{name}]). */
async function listCodexN8nServers(): Promise<string[]> {
  try {
    const { stdout } = await execa('codex', ['mcp', 'list', '--json']);
    const parsed: unknown = JSON.parse(stdout);
    const names = Array.isArray(parsed)
      ? parsed.map((s: any) => s?.name).filter((n: unknown): n is string => typeof n === 'string')
      : [];
    return names.filter(isN8nServerKey);
  } catch {
    return [];
  }
}

export const codex: ClientDef = {
  id: 'codex',
  label: 'Codex',

  detect() {
    return commandExists('codex');
  },

  async write(ctx, opts): Promise<ClientWriteResult> {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    try {
      if (opts?.overwrite) await execa('codex', ['mcp', 'remove', key]).catch(() => undefined);
      await execa('codex', codexArgs(ctx));
      return { id: 'codex', label: 'Codex', ok: true, pathKind: 'cli-managed', detail: 'codex mcp add' };
    } catch (e: any) {
      const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
      const exists = /already exists/i.test(stderr);
      return {
        id: 'codex',
        label: 'Codex',
        ok: false,
        error: exists ? 'already-exists' : e instanceof Error ? e.message : String(e),
        manual: this.manualHint(ctx),
      };
    }
  },

  async remove(serverKey): Promise<ClientWriteResult> {
    // Uninstall has no URL, so sweep every n8n* server Codex knows about (plus
    // the legacy default key as a fallback if listing fails).
    const keys = serverKey ? [serverKey] : Array.from(new Set([DEFAULT_SERVER_KEY, ...(await listCodexN8nServers())]));
    let removed = false;
    let lastError: unknown;
    for (const key of keys) {
      try {
        await execa('codex', ['mcp', 'remove', key]);
        removed = true;
      } catch (e: any) {
        const notFound = /not found|no .*server|does not exist/i.test(typeof e?.stderr === 'string' ? e.stderr : '');
        if (!notFound) lastError = e;
      }
    }
    if (removed) return { id: 'codex', label: 'Codex', ok: true, detail: 'removed' };
    if (lastError) return { id: 'codex', label: 'Codex', ok: false, error: lastError instanceof Error ? lastError.message : String(lastError) };
    return { id: 'codex', label: 'Codex', ok: false, detail: 'not configured' };
  },

  manualHint(ctx) {
    return `Run:\n  codex ${codexArgs(ctx).join(' ')}`;
  },
};
