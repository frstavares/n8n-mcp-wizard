/**
 * Types for the JSONL stream emitted by `codex exec --json`. Hand-maintained to
 * mirror @openai/codex-sdk's `ThreadEvent` without depending on the SDK (which
 * hard-pins a full codex CLI). Code defensively — unknown item/event types are ignored.
 */

export type McpToolCallItem = {
  id: string;
  type: 'mcp_tool_call';
  server: string;
  tool: string;
  arguments: unknown;
  result?: { content: unknown[]; structured_content?: unknown; _meta?: unknown };
  error?: { message: string };
  status: 'in_progress' | 'completed' | 'failed';
};
export type AgentMessageItem = { id: string; type: 'agent_message'; text: string };
export type ReasoningItem = { id: string; type: 'reasoning'; text: string };
export type CommandExecutionItem = { id: string; type: 'command_execution'; command: string; aggregated_output: string; exit_code?: number; status: string };
export type FileChangeItem = { id: string; type: 'file_change'; changes: { path: string; kind: string }[]; status: string };
export type WebSearchItem = { id: string; type: 'web_search'; query: string };
export type TodoListItem = { id: string; type: 'todo_list'; items: { text: string; completed: boolean }[] };
export type ErrorItem = { id: string; type: 'error'; message: string };

export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem;

export type Usage = { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number };

export type ThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: Usage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: ThreadItem }
  | { type: 'item.updated'; item: ThreadItem }
  | { type: 'item.completed'; item: ThreadItem }
  | { type: 'error'; message: string };
