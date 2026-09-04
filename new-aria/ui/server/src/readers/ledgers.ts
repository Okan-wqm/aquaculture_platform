// Ledger surface inventory — which declared surfaces exist, how big, last hash.
//
// WHY: the operator's first question after a cycle is "what got written"; the
// integrity index says which surfaces the kernel hash-indexes, and the file
// system says which are present and how far the chain has advanced.
// WHAT: for every file entry in LEDGER_SOURCES report presence, row count (jsonl),
// bytes, the last row's ledger_hash and whether integrity_index.json covers it.

import type { LedgerSurfaceView, LedgersResponse } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { readJsonFile, resolveInside, statSize } from '../fsafe.ts';
import { asRecord, asString, countJsonlRows, tailJsonl } from '../jsonl.ts';

export async function readLedgers(toolsDir: string): Promise<LedgersResponse> {
  const index = asRecord(await readJsonFile(resolveInside(toolsDir, LEDGER_SOURCES.integrity_index), 'integrity_index_invalid'));
  const indexed = asRecord(index?.['ledger_hashes'] ?? null) ?? {};
  const surfaces: LedgerSurfaceView[] = [];
  for (const [name, relativePath] of Object.entries(LEDGER_SOURCES)) {
    const isJsonl = relativePath.endsWith('.jsonl');
    const isJson = relativePath.endsWith('.json');
    if (!isJsonl && !isJson) continue;
    const path = resolveInside(toolsDir, relativePath);
    const bytes = await statSize(path);
    let rows: number | null = null;
    let lastHash: string | null = null;
    if (bytes !== null && isJsonl) {
      rows = await countJsonlRows(path);
      const last = (await tailJsonl<Record<string, unknown>>(path, { maxBytes: 256 * 1024, limit: 1 })).rows[0];
      lastHash = last === undefined ? null : asString(last['ledger_hash']);
    }
    const indexKey = relativePath.replace(/\.jsonl?$/, '').split('/').pop() ?? name;
    surfaces.push({ name, relativePath, present: bytes !== null, rows, bytes, lastHash, indexed: indexKey in indexed });
  }
  return { surfaces };
}
