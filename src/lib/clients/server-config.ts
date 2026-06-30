import type { WriteContext } from './types.js';

/** Native HTTP MCP server entry (Cursor). */
export function httpServerConfig(ctx: WriteContext) {
  return {
    url: ctx.mcpUrl,
    ...(ctx.apiKey ? { headers: { Authorization: `Bearer ${ctx.apiKey}` } } : {}),
  };
}

/** VS Code adds an explicit transport type. */
export function vscodeServerConfig(ctx: WriteContext) {
  return { type: 'http', ...httpServerConfig(ctx) };
}

/**
 * Claude Desktop has no native remote-HTTP transport, so we bridge via
 * `mcp-remote`. The secret rides in an env var (not inline in args).
 */
export function mcpRemoteConfig(ctx: WriteContext) {
  if (ctx.apiKey) {
    return {
      command: 'npx',
      args: ['-y', 'mcp-remote@latest', ctx.mcpUrl, '--header', 'Authorization:${N8N_MCP_AUTH}'],
      env: { N8N_MCP_AUTH: `Bearer ${ctx.apiKey}` },
    };
  }
  return { command: 'npx', args: ['-y', 'mcp-remote@latest', ctx.mcpUrl] };
}
