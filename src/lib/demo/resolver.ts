/**
 * Picks how to run the "first message" demo.
 *
 *  - agent-sdk     Claude Code is installed → drive a real agent (the user's own
 *                  local Claude) against their n8n MCP server, so the demo actually
 *                  answers using the tools. Runs on the user's Claude.
 *  - deterministic no-LLM connection check (used as the agent's fallback).
 *  - none          no Claude Code (or no token) → the caller skips the demo step.
 */
import { commandExists } from '../util/command.js';

export type DemoProvider = { kind: 'agent-sdk' } | { kind: 'deterministic' } | { kind: 'none' };

export async function resolveProvider(token?: string, exists = commandExists): Promise<DemoProvider> {
  if (!token) return { kind: 'none' };
  return (await exists('claude')) ? { kind: 'agent-sdk' } : { kind: 'none' };
}
