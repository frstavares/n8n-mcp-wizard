import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { vscodeConfigPath } from './paths.js';
import { removeJson, upsertJson } from './jsonc-file.js';
import { vscodeServerConfig } from './server-config.js';
import { DEFAULT_SERVER_KEY, type ClientDef, type ClientWriteResult } from './types.js';

export const vscode: ClientDef = {
  id: 'vscode',
  label: 'VS Code',

  async detect() {
    try {
      await access(dirname(vscodeConfigPath()));
      return true;
    } catch {
      return false;
    }
  },

  async write(ctx, opts): Promise<ClientWriteResult> {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    try {
      const { existed, written } = await upsertJson(
        vscodeConfigPath(),
        ['servers', key],
        vscodeServerConfig(ctx),
        { overwrite: opts?.overwrite },
      );
      if (existed && !written) {
        return { id: 'vscode', label: 'VS Code', ok: false, error: 'already-exists', manual: this.manualHint(ctx) };
      }
      return { id: 'vscode', label: 'VS Code', ok: true, pathKind: 'user', detail: 'User/mcp.json' };
    } catch (e) {
      return {
        id: 'vscode',
        label: 'VS Code',
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        manual: this.manualHint(ctx),
      };
    }
  },

  async remove(serverKey): Promise<ClientWriteResult> {
    const key = serverKey ?? DEFAULT_SERVER_KEY;
    try {
      const { removed } = await removeJson(vscodeConfigPath(), ['servers', key]);
      return { id: 'vscode', label: 'VS Code', ok: removed, detail: removed ? 'removed' : 'not configured' };
    } catch (e) {
      return { id: 'vscode', label: 'VS Code', ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  manualHint(ctx) {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    return `Add to VS Code's User mcp.json:\n${JSON.stringify({ servers: { [key]: vscodeServerConfig(ctx) } }, null, 2)}`;
  },
};
