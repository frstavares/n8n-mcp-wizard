import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeServerEntries, upsertJson } from '../src/lib/clients/jsonc-file.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'n8n-mcp-jsonc-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('upsertJson', () => {
  it('creates the file (and parent dirs) when it does not exist', async () => {
    const path = join(dir, 'nested', 'deep', 'config.json');
    const result = await upsertJson(path, ['mcpServers', 'n8n'], { url: 'x' }, {});
    expect(result).toEqual({ existed: false, written: true });
    expect(await readJson(path)).toEqual({ mcpServers: { n8n: { url: 'x' } } });
  });

  it('inserts the key into an existing file', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, '{}', 'utf8');
    const result = await upsertJson(path, ['servers', 'n8n'], { type: 'http' }, {});
    expect(result).toEqual({ existed: false, written: true });
    expect(await readJson(path)).toEqual({ servers: { n8n: { type: 'http' } } });
  });

  it('skips writing when the key exists and overwrite is false', async () => {
    const path = join(dir, 'config.json');
    const original = JSON.stringify({ mcpServers: { n8n: { url: 'original' } } }, null, 2);
    await writeFile(path, original, 'utf8');

    const result = await upsertJson(
      path,
      ['mcpServers', 'n8n'],
      { url: 'replacement' },
      { overwrite: false },
    );
    expect(result).toEqual({ existed: true, written: false });
    // File is untouched.
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('overwrites when overwrite is true', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ mcpServers: { n8n: { url: 'original' } } }), 'utf8');

    const result = await upsertJson(
      path,
      ['mcpServers', 'n8n'],
      { url: 'replacement' },
      { overwrite: true },
    );
    expect(result).toEqual({ existed: true, written: true });
    expect(await readJson(path)).toEqual({ mcpServers: { n8n: { url: 'replacement' } } });
  });

  it('preserves existing sibling keys when inserting', async () => {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { existing: { url: 'keep-me' } } }, null, 2),
      'utf8',
    );

    const result = await upsertJson(path, ['mcpServers', 'n8n'], { url: 'new' }, {});
    expect(result).toEqual({ existed: false, written: true });
    expect(await readJson(path)).toEqual({
      mcpServers: {
        existing: { url: 'keep-me' },
        n8n: { url: 'new' },
      },
    });
  });

  it('preserves unrelated top-level keys', async () => {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ someOtherSetting: true, mcpServers: {} }, null, 2),
      'utf8',
    );

    await upsertJson(path, ['mcpServers', 'n8n'], { url: 'new' }, {});
    const out = await readJson(path);
    expect(out.someOtherSetting).toBe(true);
    expect(out.mcpServers.n8n).toEqual({ url: 'new' });
  });

  it('treats an empty/whitespace file as an empty object', async () => {
    const path = join(dir, 'config.json');
    await mkdir(dir, { recursive: true });
    await writeFile(path, '   \n', 'utf8');
    const result = await upsertJson(path, ['a'], 1, {});
    expect(result).toEqual({ existed: false, written: true });
    expect(await readJson(path)).toEqual({ a: 1 });
  });
});

describe('removeServerEntries', () => {
  it('removes only the named server when a key is given', async () => {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { 'n8n-acme': { url: 'a' }, 'n8n-beta': { url: 'b' }, other: { url: 'c' } } }),
      'utf8',
    );
    const removed = await removeServerEntries(path, ['mcpServers'], 'n8n-acme');
    expect(removed).toEqual(['n8n-acme']);
    expect(await readJson(path)).toEqual({ mcpServers: { 'n8n-beta': { url: 'b' }, other: { url: 'c' } } });
  });

  it('sweeps every n8n* key (and only those) when no key is given', async () => {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: { n8n: { url: 'a' }, 'n8n-acme': { url: 'b' }, n8nfoo: { url: 'keep' }, other: { url: 'keep' } },
      }),
      'utf8',
    );
    const removed = await removeServerEntries(path, ['mcpServers']);
    expect(removed.sort()).toEqual(['n8n', 'n8n-acme']);
    // `n8nfoo` is NOT an n8n key (no boundary) and stays put.
    expect(await readJson(path)).toEqual({ mcpServers: { n8nfoo: { url: 'keep' }, other: { url: 'keep' } } });
  });

  it('returns [] for a missing file or absent parent path', async () => {
    expect(await removeServerEntries(join(dir, 'nope.json'), ['mcpServers'])).toEqual([]);
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ other: true }), 'utf8');
    expect(await removeServerEntries(path, ['mcpServers'])).toEqual([]);
  });

  it('preserves comments and sibling keys (JSONC)', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, '{\n  // keep me\n  "context_servers": { "n8n-acme": { "url": "a" }, "zed-thing": {} }\n}\n', 'utf8');
    const removed = await removeServerEntries(path, ['context_servers']);
    expect(removed).toEqual(['n8n-acme']);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('// keep me');
    expect(text).toContain('zed-thing');
    expect(text).not.toContain('n8n-acme');
  });
});
