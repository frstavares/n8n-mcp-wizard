import { execa } from 'execa';
import { commandExists } from '../util/command.js';
import { DEFAULT_SERVER_KEY, type ClientDef, type ClientWriteResult, type WriteContext } from './types.js';

// NOTE: Codex CLI MCP flags are modeled on the PostHog wizard's usage and need a
// real-terminal check; manualHint is the safe fallback if a flag differs.
function codexArgs(ctx: WriteContext): string[] {
  const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
  const args = ['mcp', 'add', key, '--url', ctx.mcpUrl];
  if (ctx.apiKey) args.push('--bearer-token', ctx.apiKey);
  return args;
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

  manualHint(ctx) {
    return `Run:\n  codex ${codexArgs(ctx).join(' ')}`;
  },
};
