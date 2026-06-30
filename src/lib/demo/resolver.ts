/**
 * Picks how to run the "first message" demo. We keep it deterministic: a no-LLM
 * connection proof that runs the user's prompt against their n8n and lists the
 * available tools, using the credential the wizard already holds. (We don't drive
 * an external agent — that would open its own n8n login, i.e. a second sign-in.)
 */

export type DemoProvider = { kind: 'deterministic' } | { kind: 'none' };

export async function resolveProvider(token?: string): Promise<DemoProvider> {
  return token ? { kind: 'deterministic' } : { kind: 'none' };
}
