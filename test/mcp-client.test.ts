import { describe, it, expect } from 'vitest';
import { validateToken, listTools } from '../src/lib/mcp-client.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = 'https://acme.app.n8n.cloud';
const TOKEN = 'tok';

function methodOf(init?: RequestInit): string | undefined {
  if (!init?.body) return undefined;
  try {
    return JSON.parse(String(init.body)).method;
  } catch {
    return undefined;
  }
}

/** A JSON-RPC tools/list result body. */
const toolsResult = {
  jsonrpc: '2.0',
  id: 2,
  result: {
    tools: [
      { name: 'list_workflows', description: 'List workflows' },
      { name: 'run_workflow' },
    ],
  },
};

describe('validateToken', () => {
  it('returns ok:true on a 200 initialize response', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const res = await validateToken(BASE, TOKEN, { fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it('returns ok:false reason:invalid on 401', async () => {
    const fetchImpl: FetchLike = async () => new Response(null, { status: 401 });
    const res = await validateToken(BASE, TOKEN, { fetchImpl });
    expect(res).toEqual({ ok: false, reason: 'invalid', status: 401 });
  });

  it('returns ok:false reason:invalid on 403', async () => {
    const fetchImpl: FetchLike = async () => new Response(null, { status: 403 });
    const res = await validateToken(BASE, TOKEN, { fetchImpl });
    expect(res).toEqual({ ok: false, reason: 'invalid', status: 403 });
  });

  it('returns ok:false reason:unknown on a 500', async () => {
    const fetchImpl: FetchLike = async () => new Response(null, { status: 500 });
    const res = await validateToken(BASE, TOKEN, { fetchImpl });
    expect(res).toEqual({ ok: false, reason: 'unknown', status: 500 });
  });

  it('returns ok:false reason:unknown when fetch throws', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('boom');
    };
    const res = await validateToken(BASE, TOKEN, { fetchImpl });
    expect(res).toEqual({ ok: false, reason: 'unknown' });
  });

  it('sends a Bearer authorization header to the MCP server URL', async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>)?.authorization;
      return new Response(JSON.stringify({ result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await validateToken(BASE, TOKEN, { fetchImpl });
    expect(seenUrl).toBe('https://acme.app.n8n.cloud/mcp-server/http');
    expect(seenAuth).toBe('Bearer tok');
  });
});

describe('listTools', () => {
  it('parses tools from a plain JSON response', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const method = methodOf(init);
      const body = method === 'tools/list' ? JSON.stringify(toolsResult) : JSON.stringify({ result: {} });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const tools = await listTools(BASE, TOKEN, { fetchImpl });
    expect(tools).toEqual([
      { name: 'list_workflows', description: 'List workflows' },
      { name: 'run_workflow', description: undefined },
    ]);
  });

  it('parses tools from an SSE (text/event-stream) response', async () => {
    const sse =
      ': comment line\n' +
      'event: message\n' +
      `data: ${JSON.stringify(toolsResult)}\n` +
      '\n';
    const fetchImpl: FetchLike = async (_url, init) => {
      const method = methodOf(init);
      if (method === 'tools/list') {
        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify({ result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const tools = await listTools(BASE, TOKEN, { fetchImpl });
    expect(tools.map((t) => t.name)).toEqual(['list_workflows', 'run_workflow']);
  });

  it('takes the last valid data: line in a multi-event SSE stream', async () => {
    const sse =
      'data: not-json-ignore-me\n' +
      `data: ${JSON.stringify({ result: { tools: [{ name: 'stale' }] } })}\n` +
      `data: ${JSON.stringify(toolsResult)}\n`;
    const fetchImpl: FetchLike = async (_url, init) => {
      if (methodOf(init) === 'tools/list') {
        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify({ result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const tools = await listTools(BASE, TOKEN, { fetchImpl });
    expect(tools.map((t) => t.name)).toEqual(['list_workflows', 'run_workflow']);
  });

  it('returns an empty array when the result has no tools', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const tools = await listTools(BASE, TOKEN, { fetchImpl });
    expect(tools).toEqual([]);
  });

  it('propagates the session id from initialize into the tools/list call', async () => {
    let toolsListSessionId: string | null | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      const method = methodOf(init);
      const headers = (init?.headers as Record<string, string>) ?? {};
      if (method === 'initialize') {
        return new Response(JSON.stringify({ result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' },
        });
      }
      if (method === 'tools/list') {
        toolsListSessionId = headers['mcp-session-id'];
        return new Response(JSON.stringify(toolsResult), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await listTools(BASE, TOKEN, { fetchImpl });
    expect(toolsListSessionId).toBe('sess-123');
  });
});
