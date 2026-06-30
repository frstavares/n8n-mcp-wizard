/**
 * Minimal MCP client over Streamable HTTP — just enough to validate a token
 * and run the deterministic demo (tools/list, tools/call). Not a full SDK.
 */
import { mcpServerUrl } from './instance.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface McpTool {
  name: string;
  description?: string;
}

interface JsonRpcResponse {
  result?: any;
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = '2025-06-18';

/** Parse a Streamable HTTP response body, which may be JSON or an SSE stream. */
async function parseBody(res: Response): Promise<JsonRpcResponse> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    // Take the last `data:` line that parses as JSON-RPC.
    let last: JsonRpcResponse | undefined;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m || !m[1]) continue;
      try {
        last = JSON.parse(m[1]);
      } catch {
        /* ignore non-JSON data lines */
      }
    }
    return last ?? {};
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function rpc(
  url: string,
  token: string | undefined,
  body: object,
  fetchImpl: FetchLike,
  sessionId?: string,
  timeoutMs = 15_000,
): Promise<{ res: Response; json: JsonRpcResponse; sessionId?: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  // Never let an unresponsive MCP server hang the wizard.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const json = res.ok ? await parseBody(res) : {};
  return { res, json, sessionId: res.headers.get('mcp-session-id') ?? sessionId };
}

/** Throw a clear, user-facing error when the MCP server rejects us or errors. */
function assertOk(res: Response): void {
  if (res.status === 401 || res.status === 403) {
    throw new Error(`your n8n sign-in was rejected (${res.status}) — it may have expired`);
  }
  if (!res.ok) throw new Error(`the server returned ${res.status}`);
}

export interface ValidateResult {
  ok: boolean;
  /** 'invalid' = definitively rejected (401); 'unknown' = couldn't confirm. */
  reason?: 'invalid' | 'unknown';
  status?: number;
}

/** Confirm a token is accepted by initializing a session. */
export async function validateToken(
  instanceBaseUrl: string,
  token: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ValidateResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const url = mcpServerUrl(instanceBaseUrl);
  try {
    const { res } = await rpc(url, token, initializeMessage(), fetchImpl);
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid', status: res.status };
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, reason: 'unknown', status: res.status };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
}

function initializeMessage() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'n8n-mcp-wizard', version: '0.1.0' },
    },
  };
}

/** Open a session and return its id (or undefined for stateless servers). */
export async function initialize(
  instanceBaseUrl: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const url = mcpServerUrl(instanceBaseUrl);
  const { res, sessionId } = await rpc(url, token, initializeMessage(), fetchImpl);
  assertOk(res); // surface auth/server errors instead of masking them as "no tools"
  // Best-effort: tell the server we're initialized.
  await rpc(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, fetchImpl, sessionId).catch(
    () => undefined,
  );
  return sessionId;
}

export async function listTools(
  instanceBaseUrl: string,
  token: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<McpTool[]> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const url = mcpServerUrl(instanceBaseUrl);
  const sessionId = await initialize(instanceBaseUrl, token, fetchImpl);
  const { res, json } = await rpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, fetchImpl, sessionId);
  assertOk(res);
  const tools = json.result?.tools;
  return Array.isArray(tools) ? tools.map((t: any) => ({ name: t.name, description: t.description })) : [];
}

/** Call a tool and return its raw JSON-RPC result (best-effort). */
export async function callTool(
  instanceBaseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  opts: { fetchImpl?: FetchLike } = {},
): Promise<any> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const url = mcpServerUrl(instanceBaseUrl);
  const sessionId = await initialize(instanceBaseUrl, token, fetchImpl);
  const { json } = await rpc(
    url,
    token,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
    fetchImpl,
    sessionId,
  );
  return json.result;
}
