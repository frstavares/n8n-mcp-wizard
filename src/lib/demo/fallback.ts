/** No-LLM fallbacks for the demo: prove the MCP connection, or tell the user what to do next. */
import { listTools, type McpTool } from '../mcp-client.js';
import { errorMessage } from './format.js';
import type { RunDemoOptions } from './run.js';

export const DETERMINISTIC_PROMPT = 'What can you do with my n8n instance?';

/** No-LLM fallback: prove the MCP connection and list the available tools. */
export async function runDeterministicDemo(opts: RunDemoOptions, emitPrompt = true): Promise<void> {
  const { instanceBaseUrl, token, onEvent, fetchImpl } = opts;
  if (emitPrompt) onEvent({ type: 'prompt', text: opts.prompt?.trim() || DETERMINISTIC_PROMPT });
  if (!token) {
    onEvent({ type: 'error', message: 'No token available for the connection check.' });
    return;
  }
  let tools: McpTool[];
  try {
    const list = opts.listToolsImpl ?? listTools;
    tools = await list(instanceBaseUrl, token, { fetchImpl });
  } catch (e) {
    onEvent({ type: 'error', message: `Couldn't query your n8n MCP server — ${errorMessage(e)}.` });
    return;
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

export async function runNoneDemo(opts: RunDemoOptions): Promise<void> {
  opts.onEvent({
    type: 'result',
    text: 'Setup complete. Open your AI tool and paste one of the sample prompts to try your n8n MCP server.',
  });
}
