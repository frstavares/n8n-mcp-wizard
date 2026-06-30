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

/** Names of n8n* MCP servers in Claude Code (best-effort parse of `claude mcp list`). */
async function listClaudeN8nServers(): Promise<string[]> {
  try {
    const { stdout } = await execa('claude', ['mcp', 'list']);
    const names = new Set<string>();
    for (const line of stdout.split('\n')) {
      // Each server prints as "<name>: <url> - <status>"; our keys are slugs (no spaces).
      const m = line.match(/^\s*(n8n(?:-[a-z0-9-]+)?):\s+https?:\/\//i);
      if (m?.[1]) names.add(m[1]);
    }
    return [...names];
  } catch {
    return [];
  }
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

  async remove(serverKey): Promise<ClientWriteResult> {
    // Uninstall has no URL, so sweep every n8n* server claude knows about (plus
    // the legacy default key as a fallback if listing fails).
    const keys = serverKey ? [serverKey] : Array.from(new Set([DEFAULT_SERVER_KEY, ...(await listClaudeN8nServers())]));
    let removed = false;
    let lastError: unknown;
    for (const key of keys) {
      try {
        await execa('claude', ['mcp', 'remove', '--scope', 'user', key]);
        removed = true;
      } catch (e: any) {
        const notFound = /not found|no .*server|does not exist/i.test(typeof e?.stderr === 'string' ? e.stderr : '');
        if (!notFound) lastError = e;
      }
    }
    if (removed) return { id: 'claude-code', label: 'Claude Code', ok: true, detail: 'removed' };
    if (lastError) return { id: 'claude-code', label: 'Claude Code', ok: false, error: lastError instanceof Error ? lastError.message : String(lastError) };
    return { id: 'claude-code', label: 'Claude Code', ok: false, detail: 'not configured' };
  },

  manualHint(ctx) {
    return `Run:\n  claude ${claudeArgs(ctx).join(' ')}`;
  },
};
