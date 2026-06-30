/**
 * "First message" demo module — runs immediately after the wizard writes the
 * MCP config, to prove the n8n MCP server works end-to-end.
 *
 * Public surface:
 *   resolveProvider(token?)  → which demo to run (deterministic with a token, else none)
 *   runDemo(opts)            → run it, streaming structured DemoEvents
 *   SAMPLE_PROMPTS           → build-first prompts for an empty n8n instance
 */
export { resolveProvider } from './resolver.js';
export type { DemoProvider } from './resolver.js';

export { runDemo } from './run.js';
export type { DemoEvent, RunDemoOptions } from './run.js';

/**
 * Build-first sample prompts, tuned for users with NO workflows yet. They ask
 * the agent to *build* something rather than inspect existing workflows, so the
 * demo is useful from an empty state.
 */
export const SAMPLE_PROMPTS: { id: string; text: string }[] = [
  { id: 'capabilities', text: 'What can I do with my n8n through MCP?' },
  { id: 'build-simple', text: 'Implement a simple workflow to get me started.' },
  { id: 'help-create', text: 'Help me create a workflow for my use case.' },
];

/** Prompts for users who already have workflows — discover / list / build. */
export const EXISTING_PROMPTS: { id: string; text: string }[] = [
  { id: 'capabilities', text: 'What can I do with my n8n through MCP?' },
  { id: 'list-summarize', text: 'List my workflows and summarize what each one does.' },
  { id: 'build-simple', text: 'Implement a simple new workflow for me.' },
];

/**
 * Pick the right prompt set. With a token we probe for existing workflows: if the
 * user has some, suggest using/extending them; otherwise suggest building a first
 * one. Falls back to build-first prompts on any uncertainty.
 */
export async function suggestPrompts(
  instanceBaseUrl: string,
  token?: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ id: string; text: string }[]> {
  if (!token) return SAMPLE_PROMPTS;
  try {
    return (await hasWorkflows(instanceBaseUrl, token, opts.fetchImpl)) ? EXISTING_PROMPTS : SAMPLE_PROMPTS;
  } catch {
    return SAMPLE_PROMPTS;
  }
}

async function hasWorkflows(instanceBaseUrl: string, token: string, fetchImpl?: typeof fetch): Promise<boolean> {
  const { callTool } = await import('../mcp-client.js');
  const result = await callTool(instanceBaseUrl, token, 'search_workflows', { limit: 1 }, { fetchImpl });
  return resultHasItems(result);
}

/** Best-effort: does a tools/call result indicate at least one workflow? */
function resultHasItems(result: any): boolean {
  if (!result) return false;
  if (Array.isArray(result.workflows)) return result.workflows.length > 0;
  if (Array.isArray(result.data)) return result.data.length > 0;
  if (Array.isArray(result)) return result.length > 0;
  const text = Array.isArray(result.content)
    ? result.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
    : '';
  if (!text) return false;
  if (/\bno workflows?\b/i.test(text) || /\b0 workflows?\b/i.test(text)) return false;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (Array.isArray(parsed?.workflows)) return parsed.workflows.length > 0;
    if (Array.isArray(parsed?.data)) return parsed.data.length > 0;
  } catch {
    /* not JSON */
  }
  return /\bworkflow\b/i.test(text);
}
