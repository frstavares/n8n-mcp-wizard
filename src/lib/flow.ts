/** Shared orchestration steps used by both the interactive TUI and the non-interactive runner. */
import { WizardError } from './errors.js';
import { detectInstanceType, mcpServerUrl, normalizeInstanceUrl, probeInstance } from './instance.js';
import { validateToken } from './mcp-client.js';

export interface CheckedInstance {
  url: string;
  mcpUrl: string;
  instanceType: ReturnType<typeof detectInstanceType>;
}

export function mcpDisabledError(url: string): WizardError {
  const type = detectInstanceType(url);
  const suggestion =
    type === 'self-hosted'
      ? 'Enable it: set N8N_MCP_ACCESS_ENABLED=true and restart your instance.'
      : 'Ask an instance admin to enable MCP in Settings → MCP, then re-run.';
  return new WizardError('MCP_DISABLED', `MCP isn't enabled on ${url}.`, { suggestion, context: { type } });
}

/** Normalize + probe the instance; throw a typed error if not usable. */
export async function checkInstance(raw: string): Promise<CheckedInstance> {
  const url = normalizeInstanceUrl(raw);
  const probe = await probeInstance(url);
  if (!probe.reachable) {
    throw new WizardError('UNREACHABLE', `Couldn't reach ${url}.`, {
      suggestion: 'Check the URL and that the instance is running.',
    });
  }
  if (!probe.mcpEnabled) throw mcpDisabledError(url);
  return { url, mcpUrl: mcpServerUrl(url), instanceType: probe.instanceType };
}

/** Throw INVALID_API_KEY if the token is definitively rejected. */
export async function ensureValidKey(url: string, token: string): Promise<void> {
  const v = await validateToken(url, token);
  if (!v.ok && v.reason === 'invalid') {
    throw new WizardError('INVALID_API_KEY', 'That API key was rejected by the instance.', {
      suggestion: `Generate a fresh key at ${url}/settings/mcp`,
    });
  }
}
