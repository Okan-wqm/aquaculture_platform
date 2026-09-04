// Append-only ledger reading — tail a JSONL file without loading all of it.
//
// WHY: ARIA ledgers grow for months (runs.jsonl on the monorepo is ~90 MB); a
// browser view needs the last rows, and reading a whole file per request would
// make the console the heaviest reader of the state it only observes.
// WHAT: reads at most `maxBytes` from the end, drops the partial first line when
// the read did not start at byte 0, parses each line, counts corrupt lines
// instead of failing, and returns the last `limit` rows in file order.

import { open, stat } from 'node:fs/promises';

export interface TailOptions {
  readonly maxBytes?: number;
  readonly limit?: number;
}

export interface TailResult<T> {
  readonly rows: ReadonlyArray<T>;
  readonly corrupt: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly present: boolean;
}

export const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}

export async function tailJsonl<T = Record<string, unknown>>(path: string, options: TailOptions = {}): Promise<TailResult<T>> {
  const maxBytes = options.maxBytes ?? DEFAULT_TAIL_BYTES;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (isMissing(error)) return { rows: [], corrupt: 0, bytesRead: 0, truncated: false, present: false };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    const truncated = start > 0;
    if (truncated) {
      // A read that starts mid-line yields a fragment; the row before it is
      // intact on disk but unreadable here, so it is dropped rather than parsed.
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    const rows: T[] = [];
    let corrupt = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        rows.push(JSON.parse(trimmed) as T);
      } catch {
        corrupt += 1;
      }
    }
    const limited = options.limit !== undefined && rows.length > options.limit ? rows.slice(rows.length - options.limit) : rows;
    return { rows: limited, corrupt, bytesRead: length, truncated, present: true };
  } finally {
    await handle.close();
  }
}

/** Counts newline-terminated rows without materialising them (64 KiB chunks). */
export async function countJsonlRows(path: string): Promise<number | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let count = 0;
    let position = 0;
    let lastByte = 0x0a;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] === 0x0a) count += 1;
      }
      lastByte = chunk[bytesRead - 1] ?? lastByte;
      position += bytesRead;
    }
    // A final row without a trailing newline is still a row.
    if (position > 0 && lastByte !== 0x0a) count += 1;
    return count;
  } finally {
    await handle.close();
  }
}

export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Keeps the LAST row per key, preserving first-seen order of keys. */
export function foldLatest<T>(rows: ReadonlyArray<T>, keyOf: (row: T) => string | null): Map<string, T> {
  const folded = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    folded.set(key, row);
  }
  return folded;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asStringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
