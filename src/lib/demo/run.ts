/**
 * Runs the resolved "first message" demo and streams structured events back to
 * the caller via `onEvent` (live, as they happen).
 *
 *  - cli           spawn the user's own agent CLI in non-interactive mode and
 *                  stream tool-calls live; emit one final markdown `result`.
 *  - deterministic no LLM — just prove the MCP connection by listing tools.
 *  - none          nothing installed and no token; tell the user what to do.
 *
 * The CLI is already configured with the n8n MCP server (the wizard just did
 * that), and we allow-list the n8n MCP tools so headless mode can call them.
 */
import { execa, type ExecaError } from 'execa';
import { listTools, type McpTool } from '../mcp-client.js';
import type { CliName, DemoProvider } from './resolver.js';

export type DemoEvent =
  | { type: 'prompt'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'tool-done'; name: string }
  | { type: 'text'; text: string }
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

const CLI_TIMEOUT_MS = 120_000;
const CLI_LABEL: Record<CliName, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };

export async function runDemo(opts: RunDemoOptions): Promise<void> {
  switch (opts.provider.kind) {
    case 'cli':
      return runCliDemo(opts.provider.name, opts);
    case 'deterministic':
      return runDeterministicDemo(opts);
    case 'none':
      return runNoneDemo(opts);
  }
}

/** argv for each CLI's non-interactive mode. Allow-list n8n MCP tools so the
 *  headless permission gate doesn't refuse them. */
function cliArgs(name: CliName, prompt: string, cont: boolean): string[] {
  switch (name) {
    case 'claude':
      return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__n8n', ...(cont ? ['--continue'] : [])];
    case 'codex':
      return ['exec', '--full-auto', prompt];
    case 'gemini':
      return ['-p', prompt, '--yolo'];
  }
}

async function runCliDemo(name: CliName, opts: RunDemoOptions): Promise<void> {
  const { prompt, onEvent } = opts;
  onEvent({ type: 'prompt', text: prompt });
  try {
    const subprocess = execa(name, cliArgs(name, prompt, !!opts.continueSession), { timeout: CLI_TIMEOUT_MS, buffer: false, reject: true });
    const parser = name === 'claude' ? makeClaudeStreamParser(onEvent) : makePlainTextParser(onEvent);
    if (subprocess.stdout) {
      subprocess.stdout.setEncoding('utf8');
      for await (const chunk of subprocess.stdout) parser.push(String(chunk));
    }
    await subprocess;
    parser.flush();
  } catch {
    // The CLI errored (e.g. not logged in). Fall back cleanly — no leaked output.
    if (opts.token) {
      onEvent({ type: 'text', text: `${CLI_LABEL[name]} isn't ready for a live run — verifying your connection instead…` });
      await runDeterministicDemo(opts);
    } else {
      onEvent({ type: 'result', text: `Setup complete. Open ${CLI_LABEL[name]} and paste a sample prompt to try your n8n MCP server.` });
    }
  }
}

/**
 * Parser for `claude -p --output-format stream-json --verbose` (newline-delimited
 * JSON). Tool calls stream live; assistant prose is accumulated and surfaced once
 * as a final `result` so markdown renders coherently rather than per-delta.
 */
function makeClaudeStreamParser(onEvent: (e: DemoEvent) => void) {
  let buffer = '';
  const openTools: string[] = [];
  let assistantText = '';
  let streamed = false; // did we emit live narration? then don't re-emit a final result
  // Held back until the process succeeds, so a failed run (e.g. "not logged in"
  // emitted as a result) never leaks before we fall back.
  let pendingResult = '';

  function handleObject(obj: any): void {
    if (!obj || typeof obj !== 'object') return;
    switch (obj.type) {
      case 'assistant': {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item?.type === 'text' && typeof item.text === 'string') {
              assistantText += item.text;
              if (item.text.trim()) {
                onEvent({ type: 'text', text: item.text.trim() }); // stream the agent's narration live
                streamed = true;
              }
            } else if (item?.type === 'tool_use' && typeof item.name === 'string') {
              openTools.push(item.name);
              onEvent({ type: 'tool', name: prettyToolName(item.name) });
            }
          }
        }
        break;
      }
      case 'user': {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item?.type === 'tool_result') {
              const name = openTools.shift();
              if (name) onEvent({ type: 'tool-done', name: prettyToolName(name) });
            }
          }
        }
        break;
      }
      case 'result': {
        const text = typeof obj.result === 'string' && obj.result.trim() ? obj.result : assistantText;
        if (text.trim()) pendingResult = text.trim();
        break;
      }
    }
  }

  function consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handleObject(JSON.parse(trimmed));
    } catch {
      /* ignore non-JSON noise */
    }
  }

  return {
    push(chunk: string): void {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        consumeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    flush(): void {
      if (buffer) {
        consumeLine(buffer);
        buffer = '';
      }
      if (!streamed) {
        const out = pendingResult || assistantText.trim();
        if (out) onEvent({ type: 'result', text: out });
      }
    },
  };
}

/** Plain-text parser (codex, gemini): stream tool-ish lines live, emit prose once. */
function makePlainTextParser(onEvent: (e: DemoEvent) => void) {
  let buffer = '';
  let text = '';
  const TOOL_LINE = /(?:calling tool|tool call|tool[_ ]use|using tool|\btool\b\s*[:=])\s*([A-Za-z0-9._-]+)/i;

  function consumeLine(line: string): void {
    const m = line.match(TOOL_LINE);
    if (m && m[1]) {
      onEvent({ type: 'tool', name: prettyToolName(m[1]) });
      onEvent({ type: 'tool-done', name: prettyToolName(m[1]) });
    }
    if (line.trim()) text += line + '\n';
  }

  return {
    push(chunk: string): void {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        consumeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    flush(): void {
      if (buffer) {
        consumeLine(buffer);
        buffer = '';
      }
      if (text.trim()) onEvent({ type: 'result', text: text.trim() });
    },
  };
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
    onEvent({ type: 'error', message: 'No token available for the deterministic demo.' });
    return;
  }
  onEvent({ type: 'prompt', text: DETERMINISTIC_PROMPT });

  let tools: McpTool[];
  try {
    const list = opts.listToolsImpl ?? listTools;
    tools = await list(instanceBaseUrl, token, { fetchImpl });
  } catch (e) {
    onEvent({ type: 'error', message: `Could not reach the n8n MCP server: ${errorMessage(e)}` });
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
  const err = e as Partial<ExecaError> & { message?: string };
  if (err?.timedOut) return 'timed out';
  if (typeof err?.shortMessage === 'string') return err.shortMessage;
  if (typeof err?.message === 'string') return err.message;
  return String(e);
}
