// Filesystem access that cannot leave the tools dir.
//
// WHY: every path the console reads is derived from request input (case ids,
// cycle ids, report dates) joined onto ARIA_TOOLS_DIR; a traversal there would
// expose the host. The prefix check is the single place that enforces the root.
// WHAT: resolveInside (root-bounded join), readJsonFile (absent → null, corrupt →
// HttpError 502), listDirectory (absent → []), existsInside.

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { HttpError } from './errors.ts';

export function resolveInside(root: string, ...segments: ReadonlyArray<string>): string {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new HttpError(400, 'path_outside_root');
  }
  return target;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}

export async function readJsonFile(path: string, code = 'artifact_invalid'): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(502, code, path);
  }
}

export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function listDirectory(path: string): Promise<ReadonlyArray<string>> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export async function existsInside(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function statSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
