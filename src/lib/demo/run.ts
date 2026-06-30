/**
 * Runs the "first message" demo and streams structured events back via `onEvent`.
 *
 *  - agent-sdk  Drive the user's OWN local Claude Code against their n8n MCP
 *               server, so the demo actually answers using the tools. Runs on the
 *               user's Claude (their login, their usage). Streams the response.
 *  - none       no Claude Code → caller skips the demo entirely.
 *
 * If the agent run fails, we fall back to a quick deterministic connection check.
 */
import { listTools, type McpTool } from '../mcp-client.js';
import { mcpServerUrl } from '../instance.js';
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
  /** Continue the prior Claude session (follow-up turns in the chat). */
  continueSession?: boolean;
  onEvent: (e: DemoEvent) => void;
  fetchImpl?: typeof fetch;
  listToolsImpl?: ListTools;
}

export async function runDemo(opts: RunDemoOptions): Promise<void> {
  switch (opts.provider.kind) {
    case 'agent-sdk':
      return runAgentSdkDemo(opts);
    case 'deterministic':
      return runDeterministicDemo(opts);
    case 'none':
      return runNoneDemo(opts);
  }
}

/** Drive the user's local Claude Code against their n8n MCP server, streaming the reply. */
async function runAgentSdkDemo(opts: RunDemoOptions): Promise<void> {
  const { instanceBaseUrl, token, prompt, onEvent } = opts;
  onEvent({ type: 'prompt', text: prompt });

  const openTools: string[] = [];
  let streamed = false;
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const response = query({
      prompt,
      options: {
        mcpServers: {
          n8n: {
            type: 'http',
            url: mcpServerUrl(instanceBaseUrl),
            ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
          },
        },
        allowedTools: ['mcp__n8n'], // pre-approve the n8n tools so the demo doesn't prompt
        includePartialMessages: true,
        ...(opts.continueSession ? { continue: true } : {}),
      },
    });

    for await (const msg of response as AsyncIterable<any>) {
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && typeof ev.content_block.name === 'string') {
          openTools.push(ev.content_block.name);
          onEvent({ type: 'tool', name: prettyToolName(ev.content_block.name) });
        } else if (ev?.type === 'content_block_delta') {
          const d = ev.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            onEvent({ type: 'delta', kind: 'text', text: d.text });
            streamed = true;
          }
        } else if (ev?.type === 'content_block_stop') {
          const name = openTools.shift();
          if (name) onEvent({ type: 'tool-done', name: prettyToolName(name) });
          else onEvent({ type: 'flush' });
        }
      } else if (msg.type === 'result') {
        if (!streamed && msg.subtype === 'success' && typeof msg.result === 'string' && msg.result.trim()) {
          onEvent({ type: 'result', text: msg.result.trim() });
        }
        onEvent({ type: 'flush' });
      }
    }
  } catch (e) {
    onEvent({ type: 'thinking', text: `Claude couldn't run the live demo (${errorMessage(e)}). Checking the connection instead…` });
    if (token) await runDeterministicDemo(opts, false); // prompt already emitted above
  }
}

/** Pretty-print an MCP tool id: `mcp__n8n__search_workflows` → `search_workflows`. */
function prettyToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

const DETERMINISTIC_PROMPT = 'What can you do with my n8n instance?';

/** No-LLM fallback: prove the MCP connection and list the available tools. */
async function runDeterministicDemo(opts: RunDemoOptions, emitPrompt = true): Promise<void> {
  const { instanceBaseUrl, token, onEvent, fetchImpl } = opts;
  if (emitPrompt) onEvent({ type: 'prompt', text: opts.prompt?.trim() || DETERMINISTIC_PROMPT });
  if (!token) {
    onEvent({ type: 'error', message: 'No token available for the connection check.' });
    return;
  }
  let tools: McpTool[];
  try {
    const list = opts.listToolsImpl ?? listTools;
    tools = await list(instanceBaseUrl, token, { fetchImpl });
  } catch (e) {
    onEvent({ type: 'error', message: `Couldn't query your n8n MCP server — ${errorMessage(e)}.` });
    return;
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

async function runNoneDemo(opts: RunDemoOptions): Promise<void> {
  opts.onEvent({
    type: 'result',
    text: 'Setup complete. Open your AI tool and paste one of the sample prompts to try your n8n MCP server.',
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export { DETERMINISTIC_PROMPT };
