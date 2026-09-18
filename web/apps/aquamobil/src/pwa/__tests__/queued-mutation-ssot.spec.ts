/**
 * P-23 kuralı: kuyruklu-mutation DOKÜMANLARI YALNIZ operation-registry'de yaşar.
 *
 * Tarihçe: `RECORD_DAILY_FEEDING` hem `src/graphql/operations.ts`'te hem
 * registry'de tanımlıydı; graphql kopyasının importu yoktu ve registry'den
 * sessizce ayrışmıştı (ölü ikiz, drift kaynağı). Aynı sınıftan 8 ölü kopya
 * (mortality/cull/harvest/feeding/transfer/clockIn/clockOut/createLeave)
 * Faz 6'da silindi; bu spec sınıfın geri dönüşünü kilitler.
 *
 * İstisna (dual-path allowlist): bazı op'lar önce ONLINE dener, ağ hatasında
 * kuyruğa düşer (FARM-HIGH-057 deseni) — online yolun kendi dokümanı meşrudur
 * ve canlı bir import'u vardır. Liste bilinçli olarak DAR ve gerekçelidir;
 * genişletmek registry ile doküman ayrışması riskini yeniden açar.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { OPERATION_MUTATIONS } from '../operation-registry';

const GRAPHQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'graphql');

/**
 * Online-first (dual-path) op'ların GraphQL kök alanları. Her girdinin
 * `src/graphql` içindeki dokümanını canlı bir hook import eder:
 * - submitLeaveRequest → hooks/useLeave.ts (online submit)
 * - completeTask/startTask/setChecklistItem → hooks/useTaskActions.ts
 * - sendMessage/editMessage/deleteMessage/markMessagesRead → messaging hooks
 * - acknowledgeAlert → alert hooks (MobileAcknowledgeAlert online yolu)
 */
const DUAL_PATH_ROOT_FIELDS = new Set([
  'submitLeaveRequest',
  'completeTask',
  'startTask',
  'setChecklistItem',
  'sendMessage',
  'editMessage',
  'deleteMessage',
  'markMessagesRead',
  'acknowledgeAlert',
]);

/** Registry dokümanının kök mutation alanı (ilk `{` sonrası ilk alan adı). */
function rootFieldOf(document: string): string {
  const match = /mutation\s+\w+[^{]*\{\s*(\w+)/.exec(document);
  if (!match?.[1]) {
    throw new Error(`Registry document has no parseable root field: ${document.slice(0, 80)}`);
  }
  return match[1];
}

function graphqlSourceFiles(): { name: string; content: string }[] {
  return readdirSync(GRAPHQL_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, content: readFileSync(join(GRAPHQL_DIR, name), 'utf8') }));
}

describe('queued-mutation SSoT (P-23)', () => {
  const sources = graphqlSourceFiles();

  it('no src/graphql file re-declares a queue-replayed mutation document (dual-path allowlist aside)', () => {
    const offenders: string[] = [];
    for (const document of Object.values(OPERATION_MUTATIONS)) {
      const rootField = rootFieldOf(document);
      if (DUAL_PATH_ROOT_FIELDS.has(rootField)) continue;
      for (const { name, content } of sources) {
        // Bir mutation dokümanı içindeki kök alan çağrısını arar; sorgu
        // dokümanları mutation kök alanlarını çağıramayacağı için alan adının
        // `X(` biçimli geçişi yeterli ve kesin bir sinyaldir.
        if (new RegExp(`mutation[^\`]*?\\b${rootField}\\s*\\(`, 's').test(content)) {
          offenders.push(`${rootField} → src/graphql/${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every dual-path allowlist entry still corresponds to a registry op (stale allowlist guard)', () => {
    const registryRoots = new Set(Object.values(OPERATION_MUTATIONS).map(rootFieldOf));
    for (const field of DUAL_PATH_ROOT_FIELDS) {
      expect(registryRoots, `allowlist entry ${field} is not a registry op anymore`).toContain(
        field,
      );
    }
  });
});
