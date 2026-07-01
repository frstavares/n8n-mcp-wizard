import { execa } from 'execa';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { commandExists } from '../util/command.js';
import { codexConfigPath } from './paths.js';
import { DEFAULT_SERVER_KEY, isN8nServerKey, type ClientDef, type ClientWriteResult, type WriteContext } from './types.js';

// Codex has no `codex mcp add` flag for a STATIC bearer token — only
// `--bearer-token-env-var` (a runtime env-var reference) and OAuth. To match how every
// other client embeds the wizard's key, we edit ~/.codex/config.toml directly and write
// the token as an `http_headers` entry. The edit is surgical (only our block changes),
// so comments and other servers in the user's config are preserved.

function escapeToml(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Matches our `[mcp_servers.<key>]` block (and any `.subtables`) up to the next section. */
function blockRegex(key: string): RegExp {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\[mcp_servers\\.${k}(?:\\.[^\\]\\n]+)?\\][^\\n]*(?:\\n(?![ \\t]*\\[)[^\\n]*)*`, 'g');
}

/** True if the config text already declares an `[mcp_servers.<key>]` block. */
export function hasCodexServer(existing: string, key: string): boolean {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*\\[mcp_servers\\.${k}(?:\\.[^\\]\\n]+)?\\]`, 'm').test(existing);
}

/**
 * Return `existing` config.toml text with the n8n server block upserted. API-key mode
 * embeds a static bearer via `http_headers`; OAuth mode writes the URL only (Codex signs
 * in on first use). Only our block is replaced — the rest of the file is untouched.
 */
export function upsertCodexServer(existing: string, key: string, url: string, apiKey?: string): string {
  const cleaned = existing.replace(blockRegex(key), '').replace(/\n{3,}/g, '\n\n').trimEnd();
  const lines = [`[mcp_servers.${key}]`, `url = "${escapeToml(url)}"`];
  if (apiKey) lines.push(`http_headers = { Authorization = "${escapeToml(`Bearer ${apiKey}`)}" }`);
  const block = lines.join('\n');
  return cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`;
}

/** Names of n8n* MCP servers configured in Codex (`codex mcp list --json` → [{name}]). */
async function listCodexN8nServers(): Promise<string[]> {
  try {
    const { stdout } = await execa('codex', ['mcp', 'list', '--json']);
    const parsed: unknown = JSON.parse(stdout);
    const names = Array.isArray(parsed)
      ? parsed.map((s: any) => s?.name).filter((n: unknown): n is string => typeof n === 'string')
      : [];
    return names.filter(isN8nServerKey);
  } catch {
    return [];
  }
}

export const codex: ClientDef = {
  id: 'codex',
  label: 'Codex',

  detect() {
    return commandExists('codex');
  },

  async write(ctx, opts): Promise<ClientWriteResult> {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    const path = codexConfigPath();
    try {
      let existing = '';
      try {
        existing = await readFile(path, 'utf8');
      } catch {
        /* no config yet — start fresh */
      }
      if (!opts?.overwrite && hasCodexServer(existing, key)) {
        return { id: 'codex', label: 'Codex', ok: false, error: 'already-exists', manual: this.manualHint(ctx) };
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, upsertCodexServer(existing, key, ctx.mcpUrl, ctx.apiKey), 'utf8');
      return { id: 'codex', label: 'Codex', ok: true, pathKind: 'user', detail: '~/.codex/config.toml' };
    } catch (e) {
      return { id: 'codex', label: 'Codex', ok: false, error: e instanceof Error ? e.message : String(e), manual: this.manualHint(ctx) };
    }
  },

  async remove(serverKey): Promise<ClientWriteResult> {
    // Uninstall has no URL, so sweep every n8n* server Codex knows about (plus
    // the legacy default key as a fallback if listing fails).
    const keys = serverKey ? [serverKey] : Array.from(new Set([DEFAULT_SERVER_KEY, ...(await listCodexN8nServers())]));
    let removed = false;
    let lastError: unknown;
    for (const key of keys) {
      try {
        await execa('codex', ['mcp', 'remove', key]);
        removed = true;
      } catch (e: any) {
        const notFound = /not found|no .*server|does not exist/i.test(typeof e?.stderr === 'string' ? e.stderr : '');
        if (!notFound) lastError = e;
      }
    }
    if (removed) return { id: 'codex', label: 'Codex', ok: true, detail: 'removed' };
    if (lastError) return { id: 'codex', label: 'Codex', ok: false, error: lastError instanceof Error ? lastError.message : String(lastError) };
    return { id: 'codex', label: 'Codex', ok: false, detail: 'not configured' };
  },

  manualHint(ctx) {
    const key = ctx.serverKey ?? DEFAULT_SERVER_KEY;
    if (ctx.apiKey) {
      const block = [`[mcp_servers.${key}]`, `url = "${ctx.mcpUrl}"`, 'http_headers = { Authorization = "Bearer <your-api-key>" }'].join('\n  ');
      return `Add to ~/.codex/config.toml:\n  ${block}`;
    }
    return `Run:\n  codex mcp add ${key} --url ${ctx.mcpUrl}`;
  },
};
