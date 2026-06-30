import { describe, it, expect } from 'vitest';
import { resolveProvider, type CliName } from '../src/lib/demo/resolver.js';
import { runDemo, type DemoEvent } from '../src/lib/demo/run.js';
import type { McpTool } from '../src/lib/mcp-client.js';

/** Build a fake commandExists that reports the given commands as installed. */
function installed(...present: CliName[]): (cmd: string) => Promise<boolean> {
  const set = new Set<string>(present);
  return async (cmd) => set.has(cmd);
}

/** A listTools stand-in that returns the given tools (ignores network). */
function listToolsReturning(tools: McpTool[]) {
  return async () => tools;
}

describe('resolveProvider', () => {
  it('prefers claude when all CLIs are installed', async () => {
    const p = await resolveProvider('tok', installed('claude', 'codex', 'gemini'));
    expect(p).toEqual({ kind: 'cli', name: 'claude' });
  });

  it('falls back to codex when claude is missing', async () => {
    const p = await resolveProvider('tok', installed('codex', 'gemini'));
    expect(p).toEqual({ kind: 'cli', name: 'codex' });
  });

  it('falls back to gemini when only gemini is installed', async () => {
    const p = await resolveProvider('tok', installed('gemini'));
    expect(p).toEqual({ kind: 'cli', name: 'gemini' });
  });

  it('uses the deterministic demo when no CLI but a token is present', async () => {
    const p = await resolveProvider('tok', installed());
    expect(p).toEqual({ kind: 'deterministic' });
  });

  it('returns none when no CLI and no token', async () => {
    const p = await resolveProvider(undefined, installed());
    expect(p).toEqual({ kind: 'none' });
  });
});

describe('runDemo (deterministic)', () => {
  it('emits prompt, a representative tool call, and a result summary', async () => {
    const tools: McpTool[] = [
      { name: 'n8n_create_workflow' },
      { name: 'n8n_list_workflows' },
      { name: 'n8n_search_nodes' },
    ];
    const events: DemoEvent[] = [];
    await runDemo({
      provider: { kind: 'deterministic' },
      instanceBaseUrl: 'https://acme.app.n8n.cloud',
      token: 'tok',
      prompt: 'ignored for deterministic',
      onEvent: (e) => events.push(e),
      listToolsImpl: listToolsReturning(tools),
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('prompt');
    expect(types).toContain('tool');
    expect(types).toContain('tool-done');

    // Picks a read/list/search tool as representative, not the create one.
    const toolEvent = events.find((e) => e.type === 'tool') as Extract<DemoEvent, { type: 'tool' }>;
    expect(['n8n_list_workflows', 'n8n_search_nodes']).toContain(toolEvent.name);

    const result = events.find((e) => e.type === 'result') as Extract<DemoEvent, { type: 'result' }>;
    expect(result.text).toContain('3 tools available');
    expect(result.text).toContain('n8n_create_workflow');
  });

  it('reports an empty tool list gracefully', async () => {
    const events: DemoEvent[] = [];
    await runDemo({
      provider: { kind: 'deterministic' },
      instanceBaseUrl: 'https://acme.app.n8n.cloud',
      token: 'tok',
      prompt: '',
      onEvent: (e) => events.push(e),
      listToolsImpl: listToolsReturning([]),
    });
    const result = events.find((e) => e.type === 'result') as Extract<DemoEvent, { type: 'result' }>;
    expect(result.text).toMatch(/no tools/i);
  });

  it('emits an error when the connection cannot be reached', async () => {
    const events: DemoEvent[] = [];
    await runDemo({
      provider: { kind: 'deterministic' },
      instanceBaseUrl: 'https://acme.app.n8n.cloud',
      token: 'tok',
      prompt: '',
      onEvent: (e) => events.push(e),
      listToolsImpl: async () => {
        throw new Error('boom');
      },
    });
    const err = events.find((e) => e.type === 'error') as Extract<DemoEvent, { type: 'error' }>;
    expect(err.message).toMatch(/MCP server/i);
  });
});

describe('runDemo (none)', () => {
  it('tells the user to open their tool and paste a prompt', async () => {
    const events: DemoEvent[] = [];
    await runDemo({
      provider: { kind: 'none' },
      instanceBaseUrl: 'https://acme.app.n8n.cloud',
      prompt: '',
      onEvent: (e) => events.push(e),
    });
    expect(events).toHaveLength(1);
    const result = events[0] as Extract<DemoEvent, { type: 'result' }>;
    expect(result.type).toBe('result');
    expect(result.text).toMatch(/sample prompt/i);
  });
});
