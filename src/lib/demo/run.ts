/**
 * Runs the "first message" demo and streams structured events back via `onEvent`.
 *
 *  - deterministic  no LLM — prove the MCP connection by running the user's
 *                   prompt against their n8n and listing the available tools.
 *  - none           no usable credential; tell the user what to do next.
 */
import { listTools, type McpTool } from '../mcp-client.js';
import type { DemoProvider } from './resolver.js';

export type DemoEvent =
  | { type: 'header'; agent: string; host: string } // chat header (seeded by the UI)
  | { type: 'prompt'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'tool-done'; name: string }
  | { type: 'thinking'; text: string } // rendered dim
  | { type: 'text'; text: string } // rendered bright
  | { type: 'delta'; kind: 'text' | 'thinking'; text: string } // live token stream (UI buffers it)
  | { type: 'flush' } // commit the current live block to the transcript
  | { type: 'result'; text: string } // final answer (may be markdown)
  | { type: 'error'; message: string };

type ListTools = typeof listTools;

export interface RunDemoOptions {
  provider: DemoProvider;
  instanceBaseUrl: string;
  token?: string;
  prompt: string;
  onEvent: (e: DemoEvent) => void;
  fetchImpl?: typeof fetch;
  listToolsImpl?: ListTools;
}

export async function runDemo(opts: RunDemoOptions): Promise<void> {
  switch (opts.provider.kind) {
    case 'deterministic':
      return runDeterministicDemo(opts);
    case 'none':
      return runNoneDemo(opts);
  }
}

const DETERMINISTIC_PROMPT = 'What can you do with my n8n instance?';

async function runDeterministicDemo(opts: RunDemoOptions): Promise<void> {
  const { instanceBaseUrl, token, onEvent, fetchImpl } = opts;
  if (!token) {
    onEvent({ type: 'error', message: 'No token available for the connection check.' });
    return;
  }
  onEvent({ type: 'prompt', text: opts.prompt?.trim() || DETERMINISTIC_PROMPT });

  let tools: McpTool[];
  try {
    const list = opts.listToolsImpl ?? listTools;
    tools = await list(instanceBaseUrl, token, { fetchImpl });
  } catch (e) {
    onEvent({ type: 'error', message: `Demo couldn't query your n8n MCP server — ${errorMessage(e)}.` });
    return;
  }

  const representative = pickRepresentativeTool(tools);
  if (representative) {
    onEvent({ type: 'tool', name: representative });
    onEvent({ type: 'tool-done', name: representative });
  }
  if (tools.length === 0) {
    onEvent({ type: 'result', text: 'Connected to the n8n MCP server, but it reported no tools yet.' });
    return;
  }
  const names = tools.map((t) => t.name);
  const preview = names.slice(0, 5).join(', ');
  const more = names.length > 5 ? `, +${names.length - 5} more` : '';
  onEvent({
    type: 'result',
    text: `Connected — ${tools.length} tool${tools.length === 1 ? '' : 's'} available: ${preview}${more}`,
  });
}

function pickRepresentativeTool(tools: McpTool[]): string | undefined {
  const preferred = tools.find((t) => /(^|[._-])(list|search|get)([._-]|$)/i.test(t.name));
  return (preferred ?? tools[0])?.name;
}

async function runNoneDemo(opts: RunDemoOptions): Promise<void> {
  opts.onEvent({
    type: 'result',
    text: 'Setup complete. Open your AI tool and paste one of the sample prompts to try your n8n MCP server.',
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
