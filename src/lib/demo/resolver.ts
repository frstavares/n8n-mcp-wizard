/**
 * Picks which "first message" demo to run after the wizard has written the
 * MCP server config. Prefers a real agent CLI the user already has installed;
 * falls back to a deterministic no-LLM demo when we at least have a token.
 */
import { commandExists } from '../util/command.js';

export type CliName = 'claude' | 'codex' | 'gemini';

export type DemoProvider =
  | { kind: 'cli'; name: CliName }
  | { kind: 'deterministic' }
  | { kind: 'none' };

/** CLIs we know how to drive non-interactively, in preference order. */
export const CLI_ORDER: CliName[] = ['claude', 'codex', 'gemini'];

/** Injectable for tests; defaults to the real PATH probe. */
type CommandExists = (cmd: string) => Promise<boolean>;

/**
 * Resolve the provider. `commandExistsImpl` is injectable purely so the
 * ordering logic can be unit-tested without touching the real PATH.
 */
export async function resolveProvider(
  token?: string,
  commandExistsImpl: CommandExists = commandExists,
): Promise<DemoProvider> {
  for (const name of CLI_ORDER) {
    if (await commandExistsImpl(name)) {
      return { kind: 'cli', name };
    }
  }
  if (token) return { kind: 'deterministic' };
  return { kind: 'none' };
}
