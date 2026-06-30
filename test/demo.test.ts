import { describe, it, expect } from 'vitest';
import { resolveProvider } from '../src/lib/demo/resolver.js';
import { runDemo, type DemoEvent } from '../src/lib/demo/run.js';
import type { McpTool } from '../src/lib/mcp-client.js';

/** A listTools stand-in that returns the given tools (ignores network). */
function listToolsReturning(tools: McpTool[]) {
  return async () => tools;
}

describe('resolveProvider', () => {
  it('uses the deterministic demo when a token is present', async () => {
    expect(await resolveProvider('tok')).toEqual({ kind: 'deterministic' });
  });

  it('returns none when there is no token', async () => {
    expect(await resolveProvider()).toEqual({ kind: 'none' });
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
      prompt: 'List my workflows and tell me what they do',
      onEvent: (e) => events.push(e),
      listToolsImpl: listToolsReturning(tools),
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('prompt');
    expect(types).toContain('tool');
    expect(types).toContain('tool-done');

    // The demo echoes the prompt the user actually picked, not a canned one.
    const promptEvent = events.find((e) => e.type === 'prompt') as Extract<DemoEvent, { type: 'prompt' }>;
    expect(promptEvent.text).toBe('List my workflows and tell me what they do');

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
