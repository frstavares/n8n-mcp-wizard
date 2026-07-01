/**
 * Picks how to run the "first message" demo.
 *
 *  - agent-sdk     An installed coding agent (Claude Code or Codex) drives a real
 *                  agent against the user's n8n MCP server, using the wizard's token.
 *  - deterministic no-LLM connection check (used as the agent's fallback).
 *  - none          no installed agent (or no token) → the caller skips the demo step.
 */
import { commandExists } from '../util/command.js';

export type DemoAgent = 'claude' | 'codex';

export type DemoProvider =
  | { kind: 'agent-sdk'; agent: DemoAgent }
  | { kind: 'deterministic' }
  | { kind: 'none' };

/** CLI binary that must be on PATH for each agent. */
const AGENT_BIN: Record<DemoAgent, string> = { claude: 'claude', codex: 'codex' };

/**
 * Which agents can drive the live demo: their CLI is installed AND we hold a token
 * to inject. (Model B — the SDKs/CLIs can't complete their own MCP OAuth headlessly,
 * so a token is required.) Order is the preference order shown to the user.
 */
export async function availableAgents(token?: string, exists = commandExists): Promise<DemoAgent[]> {
  if (!token) return [];
  const agents: DemoAgent[] = [];
  for (const agent of ['claude', 'codex'] as DemoAgent[]) {
    if (await exists(AGENT_BIN[agent])) agents.push(agent);
  }
  return agents;
}

/** First available agent as a provider (single-agent callers / back-compat). */
export async function resolveProvider(token?: string, exists = commandExists): Promise<DemoProvider> {
  const [first] = await availableAgents(token, exists);
  return first ? { kind: 'agent-sdk', agent: first } : { kind: 'none' };
}
