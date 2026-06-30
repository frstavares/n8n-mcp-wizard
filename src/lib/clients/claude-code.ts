import { execa } from 'execa';
import { commandExists } from '../util/command.js';
import { httpServerConfig } from './server-config.js';
import { DEFAULT_SERVER_KEY, type ClientDef, type ClientWriteResult, type WriteContext } from './types.js';

function claudeArgs(ctx: WriteContext): string[] {
  const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
  const args = ['mcp', 'add', '--transport', 'http', '--scope', 'user', key, ctx.mcpUrl];
  if (ctx.apiKey) args.push('--header', `Authorization: Bearer ${ctx.apiKey}`);
  return args;
}

export const claudeCode: ClientDef = {
  id: 'claude-code',
  label: 'Claude Code',

  detect() {
    return commandExists('claude');
  },

  async write(ctx, opts): Promise<ClientWriteResult> {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    try {
      // Claude Code manages its own config; remove an existing entry first when overwriting.
      if (opts?.overwrite) {
        await execa('claude', ['mcp', 'remove', '--scope', 'user', key]).catch(() => undefined);
      }
      await execa('claude', claudeArgs(ctx));
      return { id: 'claude-code', label: 'Claude Code', ok: true, pathKind: 'cli-managed', detail: 'claude mcp add (user scope)' };
    } catch (e: any) {
      const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
      const alreadyExists = /already exists/i.test(stderr);
      return {
        id: 'claude-code',
        label: 'Claude Code',
        ok: false,
        error: alreadyExists ? 'already-exists' : e instanceof Error ? e.message : String(e),
        manual: this.manualHint(ctx),
      };
    }
  },

  manualHint(ctx) {
    return `Run:\n  claude ${claudeArgs(ctx).join(' ')}`;
  },
};
