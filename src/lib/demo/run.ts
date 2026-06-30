/**
 * Runs the "first message" demo and streams structured events back via `onEvent`.
 *
 *  - agent-sdk      drive the user's Claude Code via @anthropic-ai/claude-agent-sdk
 *                   (their existing login — no API key), with the n8n MCP passed in
 *                   directly. Structured streaming: thinking, text, tool calls.
 *  - deterministic  no LLM — prove the MCP connection by listing tools.
 *  - none           nothing usable; tell the user what to do.
 */
import { mcpServerUrl } from '../instance.js';
import { listTools, type McpTool } from '../mcp-client.js';
import type { DemoProvider } from './resolver.js';

export type DemoEvent =
  | { type: 'header'; agent: string; host: string } // chat header (seeded by the UI)
  | { type: 'prompt'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'tool-done'; name: string }
  | { type: 'thinking'; text: string } // the agent's reasoning/narration (rendered dim)
  | { type: 'text'; text: string } // the agent's answer (rendered bright)
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
  /** Continue the previous conversation turn (multi-turn chat) instead of starting fresh. */
  continueSession?: boolean;
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

/**
 * Drive Claude Code through the Agent SDK. Uses the user's existing Claude Code
 * login (no key). We hand it the n8n MCP server + allow-list its tools, so the
 * headless permission gate can't block the call and it works mid-setup.
 */
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
            alwaysLoad: true,
          },
        },
        // Allow every n8n MCP tool (and nothing on the local machine) without prompts.
        allowedTools: ['mcp__n8n'],
        // Token-level streaming of text / thinking / tool calls.
        includePartialMessages: true,
        ...(opts.continueSession ? { continue: true } : {}),
      },
    });

    for await (const msg of response as AsyncIterable<any>) {
      if (msg?.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && typeof ev.content_block.name === 'string') {
          openTools.push(ev.content_block.name);
          onEvent({ type: 'tool', name: prettyToolName(ev.content_block.name) });
        } else if (ev?.type === 'content_block_delta') {
          const d = ev.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            onEvent({ type: 'delta', kind: 'text', text: d.text });
            streamed = true;
          } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
            onEvent({ type: 'delta', kind: 'thinking', text: d.thinking });
            streamed = true;
          }
        } else if (ev?.type === 'content_block_stop') {
          onEvent({ type: 'flush' });
        }
      } else if (msg?.type === 'user') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item?.type === 'tool_result') {
              const name = openTools.shift();
              if (name) onEvent({ type: 'tool-done', name: prettyToolName(name) });
            }
          }
        }
      } else if (msg?.type === 'result') {
        onEvent({ type: 'flush' });
        if (!streamed && msg.subtype === 'success' && typeof msg.result === 'string' && msg.result.trim()) {
          onEvent({ type: 'result', text: msg.result.trim() });
        }
      }
    }
    onEvent({ type: 'flush' });
  } catch (e) {
    onEvent({ type: 'thinking', text: `Claude Code couldn't run the live build (${errorMessage(e)}).` });
    if (token) {
      onEvent({ type: 'thinking', text: 'Verifying your connection instead…' });
      await runDeterministicDemo(opts);
    } else {
      onEvent({ type: 'result', text: 'Setup complete — open Claude Code and ask it about your n8n.' });
    }
  }
}

/** `mcp__n8n__search_workflows` → `search_workflows`. */
function prettyToolName(name: string): string {
  const parts = name.split('__');
  return parts[parts.length - 1] ?? name;
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
