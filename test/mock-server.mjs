// Tiny fake n8n MCP server for end-to-end smoke testing.
// HEAD /mcp-server/http -> 401 (enabled, needs auth). POST -> JSON-RPC result.
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  if (!req.url?.startsWith('/mcp-server/http')) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="n8n MCP Server"' }).end();
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = (() => {
        try {
          return JSON.parse(body);
        } catch {
          return {};
        }
      })();
      const auth = req.headers['authorization'];
      if (auth !== 'Bearer test-key') {
        res.writeHead(401).end();
        return;
      }
      const result =
        msg.method === 'tools/list'
          ? { tools: [{ name: 'search_workflows' }, { name: 'execute_workflow' }, { name: 'create_workflow_from_code' }] }
          : { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'n8n', version: '1.0' } };
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }));
    });
    return;
  }
  res.writeHead(405).end();
});

const port = Number(process.env.PORT ?? 7799);
server.listen(port, () => console.log(`mock n8n on http://localhost:${port}`));
