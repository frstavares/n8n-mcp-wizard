import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { isN8nServerKey } from './types.js';

export interface UpsertResult {
  existed: boolean;
  written: boolean;
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function getAtPath(obj: unknown, path: (string | number)[]): unknown {
  let cur: any = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Non-destructively upsert a value at a JSON(C) path, preserving comments and
 * formatting. Returns whether the key already existed and whether we wrote.
 * Skips writing when the key exists and `overwrite` is false.
 */
export async function upsertJson(
  path: string,
  jsonPath: (string | number)[],
  value: unknown,
  opts: { overwrite?: boolean } = {},
): Promise<UpsertResult> {
  const text = await readTextOrEmpty(path);
  const base = text.trim() ? text : '{}';
  const errors: ParseError[] = [];
  const parsed = parse(base, errors, { allowTrailingComma: true }) ?? {};
  const existed = getAtPath(parsed, jsonPath) !== undefined;
  if (existed && !opts.overwrite) {
    return { existed: true, written: false };
  }
  const edits = modify(base, jsonPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const next = applyEdits(base, edits);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, 'utf8');
  return { existed, written: true };
}

/**
 * Remove n8n server entries from a JSON(C) config. With an explicit `serverKey`,
 * removes just that one; without, sweeps every n8n* key under `parentPath` (so
 * `npx @n8n/mcp-wizard remove` cleans up per-instance keys it can't otherwise name).
 * Returns the keys actually removed. Preserves comments/formatting.
 */
export async function removeServerEntries(
  path: string,
  parentPath: (string | number)[],
  serverKey?: string,
): Promise<string[]> {
  const text = await readTextOrEmpty(path);
  if (!text.trim()) return [];
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true }) ?? {};
  const parent = getAtPath(parsed, parentPath);
  if (parent == null || typeof parent !== 'object') return [];
  const keys = serverKey
    ? Object.keys(parent as Record<string, unknown>).filter((k) => k === serverKey)
    : Object.keys(parent as Record<string, unknown>).filter(isN8nServerKey);
  if (!keys.length) return [];
  let next = text;
  for (const k of keys) {
    const edits = modify(next, [...parentPath, k], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
    next = applyEdits(next, edits);
  }
  await writeFile(path, next, 'utf8');
  return keys;
}
