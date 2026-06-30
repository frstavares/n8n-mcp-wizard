/**
 * Picks how to run the "first message" demo. We drive the user's Claude Code
 * via the Agent SDK (their existing login — no API key); if it isn't installed
 * we fall back to a deterministic no-LLM connection proof.
 */
import { commandExists } from '../util/command.js';

export type DemoProvider = { kind: 'agent-sdk' } | { kind: 'deterministic' } | { kind: 'none' };

/** Injectable for tests; defaults to the real PATH probe. */
type CommandExists = (cmd: string) => Promise<boolean>;

export async function resolveProvider(
  token?: string,
  commandExistsImpl: CommandExists = commandExists,
): Promise<DemoProvider> {
  if (await commandExistsImpl('claude')) return { kind: 'agent-sdk' };
  if (token) return { kind: 'deterministic' };
  return { kind: 'none' };
}
