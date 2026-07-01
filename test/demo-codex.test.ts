import { describe, it, expect } from 'vitest';
import type { ThreadEvent } from '../src/lib/demo/codex-events.js';
import { createCodexMapper } from '../src/lib/demo/codex.js';
import type { DemoEvent } from '../src/lib/demo/run.js';

/** Run a sequence of Codex events through a fresh mapper and collect the DemoEvents. */
function mapAll(events: ThreadEvent[]): DemoEvent[] {
  const map = createCodexMapper();
  return events.flatMap((e) => map(e));
}

describe('createCodexMapper', () => {
  it('maps an MCP tool call start to a tool event with a compact input', () => {
    const out = mapAll([
      { type: 'item.started', item: { id: 't1', type: 'mcp_tool_call', server: 'n8n', tool: 'search_workflows', arguments: { query: 'errors' }, status: 'in_progress' } },
    ] as ThreadEvent[]);
    expect(out).toEqual([{ type: 'tool', name: 'search_workflows', input: 'query: "errors"' }]);
  });

  it('maps a completed tool call to tool-done with a result summary', () => {
    const out = mapAll([
      { type: 'item.completed', item: { id: 't1', type: 'mcp_tool_call', server: 'n8n', tool: 'search_workflows', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: '[]' }], structured_content: null } } },
    ] as ThreadEvent[]);
    expect(out).toEqual([{ type: 'tool-done', name: 'tool', output: '0 results', isError: false }]);
  });

  it('maps a failed tool call to an error-flagged tool-done', () => {
    const out = mapAll([
      { type: 'item.completed', item: { id: 't1', type: 'mcp_tool_call', server: 'n8n', tool: 'x', arguments: {}, status: 'failed', error: { message: 'nope' } } },
    ] as ThreadEvent[]);
    expect(out).toEqual([{ type: 'tool-done', name: 'tool', output: 'error: nope', isError: true }]);
  });

  it('streams agent_message text as incremental deltas, then flushes on completion', () => {
    const out = mapAll([
      { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'Hello' } },
      { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'Hello world' } },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Hello world' } },
    ] as ThreadEvent[]);
    expect(out).toEqual([
      { type: 'delta', kind: 'text', text: 'Hello' },
      { type: 'delta', kind: 'text', text: ' world' },
      { type: 'flush' },
    ]);
  });

  it('maps reasoning to a thinking event and turn.completed to a flush', () => {
    const out = mapAll([
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'planning' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ] as ThreadEvent[]);
    expect(out).toEqual([{ type: 'thinking', text: 'planning' }, { type: 'flush' }]);
  });

  it('ignores lifecycle noise (thread.started, turn.failed, error)', () => {
    const out = mapAll([
      { type: 'thread.started', thread_id: 'abc' },
      { type: 'turn.failed', error: { message: 'boom' } },
      { type: 'error', message: 'fatal' },
    ] as ThreadEvent[]);
    expect(out).toEqual([]);
  });
});
