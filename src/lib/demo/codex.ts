/**
 * Drives the user's local Codex CLI against their n8n MCP server, streaming the reply.
 *
 * Model B: Codex can't complete its own MCP OAuth headlessly (a token-less server just
 * fails with "not logged in"), so we inject the wizard's token as a bearer via an env
 * var and add the n8n server through `-c mcp_servers.*` overrides. Runs against the
 * user's real ~/.codex (their model login). On any failure we fall back to the
 * deterministic connection check.
 */
import os from 'node:os';
import { execa } from 'execa';
import { mcpServerUrl } from '../instance.js';
import { prettyToolName, summarizeInput, summarizeResult, errorMessage } from './format.js';
import { runDeterministicDemo } from './fallback.js';
import type { DemoEvent, RunDemoOptions } from './run.js';
import type { ThreadEvent } from './codex-events.js';

/** Env var the injected token is exposed under (referenced by `bearer_token_env_var`). */
const TOKEN_ENV = 'N8N_MCP_TOKEN';

/** Remember the session across turns so chat follow-ups continue the same conversation. */
let lastThreadId: string | null = null;

export async function runCodexDemo(opts: RunDemoOptions): Promise<void> {
  const { instanceBaseUrl, token, prompt, onEvent } = opts;
  onEvent({ type: 'prompt', text: prompt });

  // Shared, read-only, git-agnostic run: inject only our authenticated n8n server.
  const common = [
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--cd', os.tmpdir(),
    '-c', `mcp_servers.n8n.url="${mcpServerUrl(instanceBaseUrl)}"`,
    '-c', `mcp_servers.n8n.bearer_token_env_var="${TOKEN_ENV}"`,
  ];
  const args =
    opts.continueSession && lastThreadId
      ? ['exec', 'resume', ...common, lastThreadId, prompt]
      : ['exec', ...common, prompt];

  try {
    const map = createCodexMapper();
    // execa merges `env` over process.env, so the child keeps the user's codex login.
    const subprocess = execa('codex', args, { env: { [TOKEN_ENV]: token ?? '' }, reject: false });
    for await (const line of subprocess.iterable({ from: 'stdout' })) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev: ThreadEvent;
      try {
        ev = JSON.parse(trimmed) as ThreadEvent;
      } catch {
        continue; // ignore any non-JSON banner lines
      }
      for (const out of map(ev)) onEvent(out);
      if (ev.type === 'thread.started') lastThreadId = ev.thread_id;
      if (ev.type === 'turn.failed') throw new Error(ev.error.message);
      if (ev.type === 'error') throw new Error(ev.message);
    }
    const result = await subprocess;
    if (result.exitCode !== 0) throw new Error(String(result.stderr || '').trim() || `codex exited with code ${result.exitCode}`);
  } catch (e) {
    onEvent({ type: 'thinking', text: `Codex couldn't run the live demo (${errorMessage(e)}). Checking the connection instead…` });
    if (token) await runDeterministicDemo(opts, false); // prompt already emitted above
  }
}

/**
 * Pure Codex-event → DemoEvent[] mapper. Tracks per-message text (for incremental
 * deltas) and tool-call ids (to name results). Lifecycle/terminal events map to
 * nothing here — `runCodexDemo` handles thread id capture and failure→fallback.
 */
export function createCodexMapper(): (ev: ThreadEvent) => DemoEvent[] {
  const texts = new Map<string, string>(); // agent_message id → text seen so far
  const toolNames = new Map<string, string>(); // mcp_tool_call id → pretty name

  return (ev) => {
    switch (ev.type) {
      case 'item.started':
        if (ev.item.type === 'mcp_tool_call') {
          const name = prettyToolName(ev.item.tool || 'tool');
          toolNames.set(ev.item.id, name);
          return [{ type: 'tool', name, input: summarizeInput(JSON.stringify(ev.item.arguments ?? {})) }];
        }
        return [];

      case 'item.updated':
        if (ev.item.type === 'agent_message') {
          const prev = texts.get(ev.item.id) ?? '';
          const delta = ev.item.text.slice(prev.length);
          texts.set(ev.item.id, ev.item.text);
          return delta ? [{ type: 'delta', kind: 'text', text: delta }] : [];
        }
        return [];

      case 'item.completed':
        if (ev.item.type === 'mcp_tool_call') {
          const isError = !!ev.item.error;
          const payload = isError ? ev.item.error!.message : ev.item.result?.content;
          return [{ type: 'tool-done', name: toolNames.get(ev.item.id) ?? 'tool', output: summarizeResult(payload, isError), isError }];
        }
        if (ev.item.type === 'agent_message') {
          const prev = texts.get(ev.item.id) ?? '';
          const delta = ev.item.text.slice(prev.length);
          texts.set(ev.item.id, ev.item.text);
          const out: DemoEvent[] = [];
          if (delta) out.push({ type: 'delta', kind: 'text', text: delta });
          out.push({ type: 'flush' });
          return out;
        }
        if (ev.item.type === 'reasoning') {
          return ev.item.text ? [{ type: 'thinking', text: ev.item.text }] : [];
        }
        return [];

      case 'turn.completed':
        return [{ type: 'flush' }];

      default:
        return []; // thread.started / turn.started / turn.failed / error → handled by the driver
    }
  };
}
