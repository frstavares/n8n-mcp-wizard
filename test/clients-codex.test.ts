import { describe, it, expect } from 'vitest';
import { upsertCodexServer, hasCodexServer } from '../src/lib/clients/codex.js';
import { parse } from 'smol-toml';

const URL = 'https://acme.app.n8n.cloud/mcp';

describe('upsertCodexServer', () => {
  it('writes url + a static bearer header for API-key mode (valid TOML)', () => {
    const out = upsertCodexServer('', 'n8n', URL, 'key123');
    const parsed = parse(out) as any;
    expect(parsed.mcp_servers.n8n.url).toBe(URL);
    expect(parsed.mcp_servers.n8n.http_headers.Authorization).toBe('Bearer key123');
  });

  it('writes url only (no header) for OAuth mode', () => {
    const out = upsertCodexServer('', 'n8n', URL);
    const parsed = parse(out) as any;
    expect(parsed.mcp_servers.n8n.url).toBe(URL);
    expect(parsed.mcp_servers.n8n.http_headers).toBeUndefined();
  });

  it('preserves unrelated servers and comments', () => {
    const existing = [
      '# my codex config',
      'model = "o3"',
      '',
      '[mcp_servers.context7]',
      'command = "npx"',
      '',
    ].join('\n');
    const out = upsertCodexServer(existing, 'n8n', URL, 'key123');
    expect(out).toContain('# my codex config');
    expect(out).toContain('model = "o3"');
    const parsed = parse(out) as any;
    expect(parsed.mcp_servers.context7.command).toBe('npx');
    expect(parsed.mcp_servers.n8n.url).toBe(URL);
  });

  it('replaces an existing n8n block instead of duplicating it', () => {
    const existing = ['[mcp_servers.n8n]', 'url = "https://old.example/mcp"', ''].join('\n');
    const out = upsertCodexServer(existing, 'n8n', URL, 'key123');
    expect((out.match(/\[mcp_servers\.n8n\]/g) ?? []).length).toBe(1);
    const parsed = parse(out) as any;
    expect(parsed.mcp_servers.n8n.url).toBe(URL);
  });

  it('escapes quotes and backslashes in the token', () => {
    const out = upsertCodexServer('', 'n8n', URL, 'a"b\\c');
    const parsed = parse(out) as any;
    expect(parsed.mcp_servers.n8n.http_headers.Authorization).toBe('Bearer a"b\\c');
  });
});

describe('hasCodexServer', () => {
  it('detects an existing server block', () => {
    expect(hasCodexServer('[mcp_servers.n8n]\nurl = "x"\n', 'n8n')).toBe(true);
  });
  it('is false when the block is absent', () => {
    expect(hasCodexServer('[mcp_servers.other]\nurl = "x"\n', 'n8n')).toBe(false);
    expect(hasCodexServer('', 'n8n')).toBe(false);
  });
});
