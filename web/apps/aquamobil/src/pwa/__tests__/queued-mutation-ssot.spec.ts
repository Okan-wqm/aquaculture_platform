/**
 * P-23 kuralı: kuyruklu-mutation DOKÜMANLARI YALNIZ operation-registry'de yaşar.
 *
 * Tarihçe: `RECORD_DAILY_FEEDING` hem `src/graphql/operations.ts`'te hem
 * registry'de tanımlıydı; graphql kopyasının importu yoktu ve registry'den
 * sessizce ayrışmıştı (ölü ikiz, drift kaynağı). Aynı sınıftan 8 ölü kopya
 * (mortality/cull/harvest/feeding/transfer/clockIn/clockOut/createLeave)
 * Faz 6'da silindi; bu spec sınıfın geri dönüşünü kilitler.
 *
 * MOB-HIGH-022: registry artık codegen'in kaynağı (`/* GraphQL *\/` sihirli
 * yorumu), yani her registry dokümanının üretilmiş `<Name>Document`'ı var ve
 * online yol ONU import eder — metni yeniden yazmaz. Tarama `src/**` (generated
 * ve testler hariç): su kalitesi ve stok sayfaları bir zamanlar kendi
 * kopyalarını `src/pages` altında taşıyordu ve yalnız `src/graphql`'i okuyan
 * eski tarama onları görmüyordu.
 *
 * İstisna (dual-path allowlist): online yolu daha ZENGİN bir seçim kümesi
 * isteyen op'lar (mesaj gönder/düzenle: `...MessageFields`) iki ayrı doküman
 * taşır. graphql-codegen operasyon adlarını istemci genelinde benzersiz
 * istediği için registry kopyası `<Name>Queued` adını alır; bu spec o adı da
 * pinler. Liste bilinçli olarak DAR ve gerekçelidir.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { OPERATION_MUTATIONS } from '../operation-registry';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_FILE = join(SRC_DIR, 'pwa', 'operation-registry.ts');

/**
 * Online-first (dual-path) op'ların GraphQL kök alanları. Her girdinin online
 * dokümanı registry'den FARKLI bir seçim kümesi taşır ve bu yüzden farklı
 * adlıdır (registry: `<Name>Queued`):
 * - sendMessage / editMessage → messaging-operations.ts (`...MessageFields`)
 * - acknowledgeAlert → alert-operations.ts (`MobileAcknowledgeAlert` online yolu)
 */
const DUAL_PATH_ROOT_FIELDS = new Set(['sendMessage', 'editMessage', 'acknowledgeAlert']);

/** Registry dokümanının kök mutation alanı (ilk `{` sonrası ilk alan adı). */
function rootFieldOf(document: string): string {
  const match = /mutation\s+\w+[^{]*\{\s*(\w+)/.exec(document);
  if (!match?.[1]) {
    throw new Error(`Registry document has no parseable root field: ${document.slice(0, 80)}`);
  }
  return match[1];
}

function operationNameOf(document: string): string {
  const match = /mutation\s+(\w+)/.exec(document);
  if (!match?.[1]) {
    throw new Error(`Registry document has no operation name: ${document.slice(0, 80)}`);
  }
  return match[1];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'generated' || name === '__tests__') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.spec\.tsx?$/.test(name)) continue;
    if (full === REGISTRY_FILE) continue;
    out.push(full);
  }
  return out;
}

describe('queued-mutation SSoT (P-23)', () => {
  const sources = sourceFiles(SRC_DIR).map((path) => ({
    name: relative(SRC_DIR, path),
    content: readFileSync(path, 'utf8'),
  }));

  it('no source file outside the registry re-declares a queue-replayed mutation document (dual-path allowlist aside)', () => {
    const offenders: string[] = [];
    for (const document of Object.values(OPERATION_MUTATIONS)) {
      const rootField = rootFieldOf(document);
      if (DUAL_PATH_ROOT_FIELDS.has(rootField)) continue;
      for (const { name, content } of sources) {
        // Bir mutation dokümanı içindeki kök alan çağrısını arar; sorgu
        // dokümanları mutation kök alanlarını çağıramayacağı için alan adının
        // `X(` biçimli geçişi yeterli ve kesin bir sinyaldir.
        if (new RegExp(`mutation[^\`]*?\\b${rootField}\\s*\\(`, 's').test(content)) {
          offenders.push(`${rootField} → ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every registry document is a codegen source (magic comment) and stays interpolation-free', () => {
    const registry = readFileSync(REGISTRY_FILE, 'utf8');
    const commented = registry.match(/^ {2}\w+: \/\* GraphQL \*\/ `/gm) ?? [];
    expect(commented).toHaveLength(Object.keys(OPERATION_MUTATIONS).length);
    for (const document of Object.values(OPERATION_MUTATIONS)) {
      expect(document).not.toContain('${');
    }
  });

  it('every dual-path allowlist entry still corresponds to a registry op named <Name>Queued (stale allowlist guard)', () => {
    const registryByRoot = new Map(
      Object.values(OPERATION_MUTATIONS).map((document) => [rootFieldOf(document), document]),
    );
    for (const field of DUAL_PATH_ROOT_FIELDS) {
      const document = registryByRoot.get(field);
      expect(document, `allowlist entry ${field} is not a registry op anymore`).toBeDefined();
      if (document === undefined) continue;
      expect(operationNameOf(document)).toMatch(/Queued$/);
    }
  });

  it('a registry op outside the allowlist is not named as if it had an online twin', () => {
    for (const document of Object.values(OPERATION_MUTATIONS)) {
      if (DUAL_PATH_ROOT_FIELDS.has(rootFieldOf(document))) continue;
      expect(operationNameOf(document)).not.toMatch(/Queued$/);
    }
  });
});
