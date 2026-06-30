import { detectInstanceType } from '../instance.js';
import type { ClientDef, ClientWriteResult } from './types.js';

const CONNECTORS_URL = 'https://claude.ai/settings/connectors';

/** The n8n host must be reachable from Anthropic's servers (no localhost / private IPs). */
function isPubliclyReachable(mcpUrl: string): boolean {
  return detectInstanceType(mcpUrl) !== 'self-hosted';
}

/**
 * Claude.ai (web) — a hosted "custom connector", not a local config file. The user
 * pastes the MCP URL in claude.ai and authorizes via OAuth in the browser. Offered
 * but opt-in (autoSelect:false). Requires a *publicly reachable* HTTPS instance and
 * a paid plan; there's no key/header injection here (claude.ai does its own OAuth).
 */
export const claudeWeb: ClientDef = {
  id: 'claude-web',
  label: 'Claude.ai (web)',
  autoSelect: false,

  async detect() {
    return true; // hosted — always available to offer
  },

  async write(ctx): Promise<ClientWriteResult> {
    if (!isPubliclyReachable(ctx.mcpUrl)) {
      return {
        id: 'claude-web',
        label: 'Claude.ai (web)',
        ok: false,
        error: "claude.ai can't reach a local/private instance — it needs a public HTTPS URL.",
        manual: this.manualHint(ctx),
      };
    }
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
      detail: 'opened claude.ai — finish in the browser (see steps)',
      manual: this.manualHint(ctx),
    };
  },

  manualHint(ctx) {
    return [
      'In claude.ai (needs Pro/Max/Team/Enterprise):',
      '  Settings → Connectors → Add custom connector',
      `  Paste this URL:  ${ctx.mcpUrl}`,
      '  Click Connect, then approve the n8n login (OAuth).',
      '  Note: the instance must be reachable over the public internet — localhost/private hosts won’t work.',
    ].join('\n');
  },
};
