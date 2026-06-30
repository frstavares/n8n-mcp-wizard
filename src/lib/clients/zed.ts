import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { zedConfigPath } from './paths.js';
import { upsertJson } from './jsonc-file.js';
import { httpServerConfig } from './server-config.js';
import { DEFAULT_SERVER_KEY, type ClientDef, type ClientWriteResult } from './types.js';

export const zed: ClientDef = {
  id: 'zed',
  label: 'Zed',

  async detect() {
    try {
      await access(dirname(zedConfigPath()));
      return true;
    } catch {
      return false;
    }
  },

  async write(ctx, opts): Promise<ClientWriteResult> {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    try {
      const { existed, written } = await upsertJson(
        zedConfigPath(),
        ['context_servers', key],
        { ...httpServerConfig(ctx), enabled: true },
        { overwrite: opts?.overwrite },
      );
      if (existed && !written) {
        return { id: 'zed', label: 'Zed', ok: false, error: 'already-exists', manual: this.manualHint(ctx) };
      }
      return { id: 'zed', label: 'Zed', ok: true, pathKind: 'user', detail: 'zed/settings.json (restart Zed)' };
    } catch (e) {
      return {
        id: 'zed',
        label: 'Zed',
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        manual: this.manualHint(ctx),
      };
    }
  },

  manualHint(ctx) {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    return `Add to Zed settings.json:\n${JSON.stringify({ context_servers: { [key]: { ...httpServerConfig(ctx), enabled: true } } }, null, 2)}`;
  },
};
