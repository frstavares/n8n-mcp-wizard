import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cursorConfigPath } from './paths.js';
import { removeServerEntries, upsertJson } from './jsonc-file.js';
import { httpServerConfig } from './server-config.js';
import { DEFAULT_SERVER_KEY, type ClientDef, type ClientWriteResult, type WriteContext } from './types.js';

export const cursor: ClientDef = {
  id: 'cursor',
  label: 'Cursor',

  async detect() {
    try {
      await access(dirname(cursorConfigPath()));
      return true;
    } catch {
      return false;
    }
  },

  async write(ctx, opts): Promise<ClientWriteResult> {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    try {
      const { existed, written } = await upsertJson(
        cursorConfigPath(),
        ['mcpServers', key],
        httpServerConfig(ctx),
        { overwrite: opts?.overwrite },
      );
      if (existed && !written) {
        return { id: 'cursor', label: 'Cursor', ok: false, error: 'already-exists', manual: this.manualHint(ctx) };
      }
      return { id: 'cursor', label: 'Cursor', ok: true, pathKind: 'user', detail: '~/.cursor/mcp.json' };
    } catch (e) {
      return {
        id: 'cursor',
        label: 'Cursor',
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        manual: this.manualHint(ctx),
      };
    }
  },

  async remove(serverKey): Promise<ClientWriteResult> {
    try {
      const removed = await removeServerEntries(cursorConfigPath(), ['mcpServers'], serverKey);
      const ok = removed.length > 0;
      return { id: 'cursor', label: 'Cursor', ok, detail: ok ? 'removed' : 'not configured' };
    } catch (e) {
      return { id: 'cursor', label: 'Cursor', ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  manualHint(ctx) {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    return `Add to ~/.cursor/mcp.json:\n${JSON.stringify({ mcpServers: { [key]: httpServerConfig(ctx) } }, null, 2)}`;
  },
};
