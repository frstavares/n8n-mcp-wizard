import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WriteContext } from '../src/lib/clients/types.js';

/**
 * IMPORTANT: src/lib/clients/paths.ts captures `homedir()` ONCE at module load
 * (`const home = homedir()`), and every *ConfigPath() reads that captured value.
 * homedir() on POSIX derives from process.env.HOME. So to redirect the writes
 * into a temp dir we must:
 *   1. set process.env.HOME to the temp dir,
 *   2. vi.resetModules() to drop any cached copy of paths.ts,
 *   3. dynamically `await import()` the client AFTER setting HOME.
 * A statically-imported client would have already frozen the real home dir.
 */

const MCP_URL = 'https://x/mcp-server/http';

let home: string;
let savedHome: string | undefined;
let savedAppData: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'n8n-mcp-home-'));
  savedHome = process.env.HOME;
  savedAppData = process.env.APPDATA;
  process.env.HOME = home;
  // Leave APPDATA set to the temp dir too, in case the test runs on win32.
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  vi.resetModules();
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = savedAppData;
  await rm(home, { recursive: true, force: true });
});

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'));
}

const ctxWithKey: WriteContext = { mcpUrl: MCP_URL, apiKey: 'k', serverKey: 'n8n' };
const ctxOAuth: WriteContext = { mcpUrl: MCP_URL, serverKey: 'n8n' };

describe('cursor.write', () => {
  it('writes mcpServers.n8n with url + Bearer Authorization header (API-key mode)', async () => {
    const { cursor } = await import('../src/lib/clients/cursor.js');
    const { cursorConfigPath } = await import('../src/lib/clients/paths.js');
    const result = await cursor.write(ctxWithKey, {});
    expect(result.ok).toBe(true);

    const cfg = await readJson(cursorConfigPath());
    expect(cfg.mcpServers.n8n).toEqual({
      url: MCP_URL,
      headers: { Authorization: 'Bearer k' },
    });
  });

  it('omits headers in OAuth mode (no apiKey)', async () => {
    const { cursor } = await import('../src/lib/clients/cursor.js');
    const { cursorConfigPath } = await import('../src/lib/clients/paths.js');
    await cursor.write(ctxOAuth, {});
    const cfg = await readJson(cursorConfigPath());
    expect(cfg.mcpServers.n8n).toEqual({ url: MCP_URL });
    expect(cfg.mcpServers.n8n.headers).toBeUndefined();
  });

  it('reports already-exists when key present and overwrite is false', async () => {
    const { cursor } = await import('../src/lib/clients/cursor.js');
    await cursor.write(ctxWithKey, {});
    const second = await cursor.write(ctxWithKey, { overwrite: false });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('already-exists');
  });
});

describe('vscode.write', () => {
  it('writes servers.n8n with type:http, url and headers (API-key mode)', async () => {
    const { vscode } = await import('../src/lib/clients/vscode.js');
    const { vscodeConfigPath } = await import('../src/lib/clients/paths.js');
    const result = await vscode.write(ctxWithKey, {});
    expect(result.ok).toBe(true);

    const cfg = await readJson(vscodeConfigPath());
    expect(cfg.servers.n8n).toEqual({
      type: 'http',
      url: MCP_URL,
      headers: { Authorization: 'Bearer k' },
    });
  });

  it('omits headers in OAuth mode but keeps type:http', async () => {
    const { vscode } = await import('../src/lib/clients/vscode.js');
    const { vscodeConfigPath } = await import('../src/lib/clients/paths.js');
    await vscode.write(ctxOAuth, {});
    const cfg = await readJson(vscodeConfigPath());
    expect(cfg.servers.n8n).toEqual({ type: 'http', url: MCP_URL });
  });
});

describe('claudeDesktop.write', () => {
  it('writes an mcp-remote bridge with the secret in env (API-key mode)', async () => {
    const { claudeDesktop } = await import('../src/lib/clients/claude-desktop.js');
    const { claudeDesktopConfigPath } = await import('../src/lib/clients/paths.js');
    const result = await claudeDesktop.write(ctxWithKey, {});
    expect(result.ok).toBe(true);

    const cfg = await readJson(claudeDesktopConfigPath());
    expect(cfg.mcpServers.n8n).toEqual({
      command: 'npx',
      args: ['-y', 'mcp-remote@latest', MCP_URL, '--header', 'Authorization:${N8N_MCP_AUTH}'],
      env: { N8N_MCP_AUTH: 'Bearer k' },
    });
  });

  it('omits header arg and env in OAuth mode (no apiKey)', async () => {
    const { claudeDesktop } = await import('../src/lib/clients/claude-desktop.js');
    const { claudeDesktopConfigPath } = await import('../src/lib/clients/paths.js');
    await claudeDesktop.write(ctxOAuth, {});
    const cfg = await readJson(claudeDesktopConfigPath());
    expect(cfg.mcpServers.n8n).toEqual({
      command: 'npx',
      args: ['-y', 'mcp-remote@latest', MCP_URL],
    });
    expect(cfg.mcpServers.n8n.env).toBeUndefined();
    expect(cfg.mcpServers.n8n.args).not.toContain('--header');
  });
});
