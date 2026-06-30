import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { claudeDesktopConfigPath } from './paths.js';
import { removeJson, upsertJson } from './jsonc-file.js';
import { mcpRemoteConfig } from './server-config.js';
import { DEFAULT_SERVER_KEY, type ClientDef, type ClientWriteResult } from './types.js';

export const claudeDesktop: ClientDef = {
  id: 'claude-desktop',
  label: 'Claude Desktop',

  async detect() {
    try {
      await access(dirname(claudeDesktopConfigPath()));
      return true;
    } catch {
      return false;
    }
  },

  async write(ctx, opts): Promise<ClientWriteResult> {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    try {
      const { existed, written } = await upsertJson(
        claudeDesktopConfigPath(),
        ['mcpServers', key],
        mcpRemoteConfig(ctx),
        { overwrite: opts?.overwrite },
      );
      if (existed && !written) {
        return {
          id: 'claude-desktop',
          label: 'Claude Desktop',
          ok: false,
          error: 'already-exists',
          manual: this.manualHint(ctx),
        };
      }
      return {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        ok: true,
        pathKind: 'user',
        detail: 'claude_desktop_config.json (restart Claude Desktop)',
      };
    } catch (e) {
      return {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        manual: this.manualHint(ctx),
      };
    }
  },

  async remove(serverKey): Promise<ClientWriteResult> {
    const key = serverKey ?? DEFAULT_SERVER_KEY;
    try {
      const { removed } = await removeJson(claudeDesktopConfigPath(), ['mcpServers', key]);
      return { id: 'claude-desktop', label: 'Claude Desktop', ok: removed, detail: removed ? 'removed (restart Claude Desktop)' : 'not configured' };
    } catch (e) {
      return { id: 'claude-desktop', label: 'Claude Desktop', ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  manualHint(ctx) {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    return `Add to claude_desktop_config.json:\n${JSON.stringify({ mcpServers: { [key]: mcpRemoteConfig(ctx) } }, null, 2)}`;
  },
};
