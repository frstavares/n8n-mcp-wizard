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
import { listTools } from '../mcp-client.js';
import { mcpServerUrl } from '../instance.js';
import { prettyToolName, summarizeInput, summarizeResult, errorMessage } from './format.js';
import { runDeterministicDemo, runNoneDemo } from './fallback.js';
import { runCodexDemo } from './codex.js';
import type { DemoProvider } from './resolver.js';

export type DemoEvent =
  | { type: 'header'; agent: string; host: string } // chat header (seeded by the UI)
  | { type: 'prompt'; text: string }
  | { type: 'tool'; name: string; input?: string } // input = compact args summary
  | { type: 'tool-done'; name: string; output?: string; isError?: boolean } // output = human summary
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
      return opts.provider.agent === 'codex' ? runCodexDemo(opts) : runClaudeDemo(opts);
    case 'deterministic':
      return runDeterministicDemo(opts);
    case 'none':
      return runNoneDemo(opts);
  }
}

/** Drive the user's local Claude Code against their n8n MCP server, streaming the reply. */
async function runClaudeDemo(opts: RunDemoOptions): Promise<void> {
  const { instanceBaseUrl, token, prompt, onEvent } = opts;
  onEvent({ type: 'prompt', text: prompt });

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
        // Use ONLY this header-authed server (the OAuth token we already hold).
        // Without this, the spawned Claude also loads the user's ~/.claude.json n8n
        // server (token-less) and runs its own n8n OAuth — the sign-in we don't want.
        strictMcpConfig: true,
        includePartialMessages: true,
        ...(opts.continueSession ? { continue: true } : {}),
      },
    });

    const toolNames = new Map<string, string>(); // tool_use_id → pretty name (for results)
    let curTool: { id: string; name: string; input: string } | null = null;
    for await (const msg of response as AsyncIterable<any>) {
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          curTool = { id: ev.content_block.id, name: prettyToolName(ev.content_block.name ?? 'tool'), input: '' };
        } else if (ev?.type === 'content_block_delta') {
          const d = ev.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            onEvent({ type: 'delta', kind: 'text', text: d.text });
            streamed = true;
          } else if (d?.type === 'input_json_delta' && curTool && typeof d.partial_json === 'string') {
            curTool.input += d.partial_json; // tool args stream in as partial JSON
          }
        } else if (ev?.type === 'content_block_stop') {
          if (curTool) {
            toolNames.set(curTool.id, curTool.name);
            onEvent({ type: 'tool', name: curTool.name, input: summarizeInput(curTool.input) });
            curTool = null;
          } else {
            onEvent({ type: 'flush' }); // end of a streamed text block
          }
        }
      } else if (msg.type === 'user') {
        // Tool results arrive as user messages — surface a snippet of the output.
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_result') {
              const isError = block.is_error === true;
              onEvent({ type: 'tool-done', name: toolNames.get(block.tool_use_id) ?? 'tool', output: summarizeResult(block.content, isError), isError });
            }
          }
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

export { DETERMINISTIC_PROMPT } from './fallback.js';
