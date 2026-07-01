import { describe, it, expect } from 'vitest';
import { resolveProvider, availableAgents } from '../src/lib/demo/resolver.js';
import { runDemo, type DemoEvent } from '../src/lib/demo/run.js';
import type { McpTool } from '../src/lib/mcp-client.js';

/** A listTools stand-in that returns the given tools (ignores network). */
function listToolsReturning(tools: McpTool[]) {
  return async () => tools;
}

describe('availableAgents', () => {
  it('lists both agents when both CLIs are installed and a token is present', async () => {
    expect(await availableAgents('tok', async () => true)).toEqual(['claude', 'codex']);
  });

  it('lists only the installed agent', async () => {
    const onlyCodex = async (bin: string) => bin === 'codex';
    expect(await availableAgents('tok', onlyCodex)).toEqual(['codex']);
  });

  it('is empty without a token', async () => {
    expect(await availableAgents(undefined, async () => true)).toEqual([]);
  });
});

describe('resolveProvider', () => {
  it('drives the first available agent when installed and a token is present', async () => {
    expect(await resolveProvider('tok', async () => true)).toEqual({ kind: 'agent-sdk', agent: 'claude' });
  });

  it('skips the demo (none) when no agent is installed', async () => {
    expect(await resolveProvider('tok', async () => false)).toEqual({ kind: 'none' });
  });

  it('returns none when there is no token', async () => {
    expect(await resolveProvider(undefined, async () => true)).toEqual({ kind: 'none' });
  });
});

describe('runDemo (deterministic fallback)', () => {
  it('echoes the chosen prompt and summarizes the connected tools', async () => {
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
    expect(types).toContain('result');

    // Echoes the prompt the user actually picked, not a canned one.
    const promptEvent = events.find((e) => e.type === 'prompt') as Extract<DemoEvent, { type: 'prompt' }>;
    expect(promptEvent.text).toBe('List my workflows and tell me what they do');

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
