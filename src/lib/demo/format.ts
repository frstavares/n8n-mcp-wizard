/** Shared formatters for the demo drivers: pretty tool names, compact arg/result summaries. */

/** Pretty-print an MCP tool id: `mcp__n8n__search_workflows` → `search_workflows`. */
export function prettyToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

/** One-line summary of a tool's JSON args, e.g. `{"query":"errors"}` → `query: "errors"`. */
export function summarizeInput(json: string): string | undefined {
  const raw = json.trim();
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const s = Object.entries(obj)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      return truncate(s, 72);
    }
    return truncate(JSON.stringify(obj), 72);
  } catch {
    return truncate(raw, 72);
  }
}

/**
 * Human, one-line summary of a tool result — never a raw JSON dump. Extracts a
 * status/count when the payload is JSON, a short message on error, and collapses
 * the oversized-output notice the runtime emits for huge results.
 */
export function summarizeResult(content: unknown, isError: boolean): string {
  const text = extractText(content).replace(/\s+/g, ' ').trim();
  if (/exceeds?.*maximum|too large|output has been saved/i.test(text)) return 'large result';
  if (isError) return `error${text ? `: ${truncate(text, 80)}` : ''}`;
  if (!text) return 'done';
  try {
    const obj = JSON.parse(text);
    const status = obj?.execution?.status ?? obj?.status;
    if (typeof status === 'string') return status;
    const list = Array.isArray(obj) ? obj : (obj?.workflows ?? obj?.data ?? obj?.results);
    if (Array.isArray(list)) return `${list.length} result${list.length === 1 ? '' : 's'}`;
    return 'done';
  } catch {
    return truncate(text, 72); // non-JSON: show a short snippet
  }
}

/** Pull text out of a tool-result content payload (string or array of text blocks). */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(' ');
  return '';
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
