import { DEFAULT_SERVER_KEY, type ClientDef, type ClientWriteResult } from './types.js';

const CONNECTORS_URL = 'https://claude.ai/settings/connectors';

/**
 * Claude.ai (web) — a hosted "custom connector", not a local config file.
 * Always offered, but opt-in (autoSelect:false) since "configuring" it just
 * opens the browser for the user to paste the MCP URL.
 */
export const claudeWeb: ClientDef = {
  id: 'claude-web',
  label: 'Claude.ai (web)',
  autoSelect: false,

  async detect() {
    return true; // hosted — always available
  },

  async write(ctx): Promise<ClientWriteResult> {
    if (process.stdout.isTTY) {
      try {
        const open = (await import('open')).default;
        await open(CONNECTORS_URL);
      } catch {
        /* opening the browser is best-effort */
      }
    }
    return {
      id: 'claude-web',
      label: 'Claude.ai (web)',
      ok: true,
      pathKind: 'browser',
      detail: 'opened claude.ai — add a custom connector',
      manual: this.manualHint(ctx),
    };
  },

  manualHint(ctx) {
    return `In claude.ai → Settings → Connectors → Add custom connector, use:\n  ${ctx.mcpUrl}`;
  },
};
