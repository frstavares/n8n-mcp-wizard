import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

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

/** Remove a key at a JSON(C) path, preserving the rest. No-op if absent or file missing. */
export async function removeJson(path: string, jsonPath: (string | number)[]): Promise<{ removed: boolean }> {
  const text = await readTextOrEmpty(path);
  if (!text.trim()) return { removed: false };
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true }) ?? {};
  if (getAtPath(parsed, jsonPath) === undefined) return { removed: false };
  const edits = modify(text, jsonPath, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  await writeFile(path, applyEdits(text, edits), 'utf8');
  return { removed: true };
}
