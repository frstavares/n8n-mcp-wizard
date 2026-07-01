/**
 * Drives the user's local Codex CLI against their n8n MCP server, streaming the reply.
 *
 * Model B: Codex can't complete its own MCP OAuth headlessly, so we inject the wizard's
 * token as a bearer. Crucially, Codex has no `strictMcpConfig` equivalent — a plain
 * `codex exec` loads EVERY server in the user's ~/.codex/config.toml and blocks on their
 * startup, so an unrelated slow/broken server stalls the whole run (the demo shows
 * nothing). We isolate the run in a throwaway CODEX_HOME containing ONLY our n8n server
 * (plus the user's copied login), matching how the Claude path isolates via strictMcpConfig.
 * On any failure we fall back to the deterministic connection check.
 */
import os from 'node:os';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { mcpServerUrl } from '../instance.js';
import { prettyToolName, summarizeInput, summarizeResult, errorMessage } from './format.js';
import { runDeterministicDemo } from './fallback.js';
import type { DemoEvent, RunDemoOptions } from './run.js';
import type { ThreadEvent } from './codex-events.js';

/** Env var the injected token is exposed under (referenced by `bearer_token_env_var`). */
const TOKEN_ENV = 'N8N_MCP_TOKEN';

/** Overall safety net: a stalled MCP handshake should fall back, never hang forever. */
const RUN_TIMEOUT_MS = 180_000;

/** Isolated Codex home + last session id, reused across turns so follow-ups resume. */
let codexHome: string | null = null;
let lastThreadId: string | null = null;

/**
 * Create (once) a throwaway CODEX_HOME that contains ONLY our n8n server and a copy of
 * the user's login, so the run ignores every other server in their real config.
 */
async function ensureCodexHome(instanceBaseUrl: string): Promise<string> {
  if (codexHome) return codexHome;
  const home = await mkdtemp(join(os.tmpdir(), 'n8n-codex-'));
  // Best-effort: copy the file-based ChatGPT/API login so model calls work in isolation.
  // (Keyring logins are global and found without copying; if neither exists the run fails
  // fast and we fall back.)
  await copyFile(join(os.homedir(), '.codex', 'auth.json'), join(home, 'auth.json')).catch(() => undefined);
  const url = mcpServerUrl(instanceBaseUrl);
  const config = `[mcp_servers.n8n]\nurl = "${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nbearer_token_env_var = "${TOKEN_ENV}"\n`;
  await writeFile(join(home, 'config.toml'), config, 'utf8');
  codexHome = home;
  return home;
}

export async function runCodexDemo(opts: RunDemoOptions): Promise<void> {
  const { instanceBaseUrl, token, prompt, onEvent } = opts;
  onEvent({ type: 'prompt', text: prompt });
  try {
    const home = await ensureCodexHome(instanceBaseUrl);
    const common = ['--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', os.tmpdir()];
    const args =
      opts.continueSession && lastThreadId
        ? ['exec', 'resume', ...common, lastThreadId, prompt]
        : ['exec', ...common, prompt];

    const map = createCodexMapper();
    const subprocess = execa('codex', args, {
      env: { CODEX_HOME: home, [TOKEN_ENV]: token ?? '' },
      reject: false,
      timeout: RUN_TIMEOUT_MS,
    });
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
