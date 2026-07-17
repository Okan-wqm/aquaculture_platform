/**
 * Mobil komut zarfı üreticisi — WEB tarafı (Faz 6, C-17).
 *
 * `recordMealFeeding` stok düşüren bir komuttur ve backend zarfı ZORUNLU
 * kılar (clientCommandId + payloadHash; zarfsız istek fail-closed reddedilir
 * — tests/invariants/stock-mutating-handlers-reject-legacy.spec.ts). Mobil
 * offline kuyruğu zarfı kendi üretir; web çağıranlar bu yardımcıyı kullanır.
 *
 * payloadHash, zarf alanları EKLENMEDEN önceki komut yükünün SHA-256'sıdır
 * (mobil kuyruğun stableStringify paritesi — anahtarlar özyinelemeli
 * sıralanır ki aynı yük her zaman aynı hash'i üretsin, P-29).
 */

export interface CommandEnvelope {
  clientCommandId: string;
  clientCreatedAt: string;
  operationType: string;
  payloadHash: string;
}

/**
 * Deterministik, ÖZYİNELEMELİ anahtar-sıralı stringify — sunucunun at-most-once
 * payloadHash sözleşmesinin kanonik biçimi. Web'in TEK kopyası budur
 * (useBatches buradan import eder — FARM-LOW-235 tekilleştirmesi).
 *
 * FARM-LOW-141: AquaMobil'in kopyasıyla
 * (web/apps/aquamobil/src/pwa/offline-queue.ts) BYTE-BYTE aynı kalmak
 * ZORUNDADIR — iki istemci tek dedup sözleşmesini aynı biçimle hash'ler
 * (undefined-değerli anahtarlar da serileştirilir; filtreleme sapmaydı).
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verilen komut yükü için tam zarf üretir. Retry'da AYNI zarf yeniden
 * gönderilmelidir (idempotent replay) — çağıran zarfı mutation süresince
 * saklar, her denemede yeniden ÜRETMEZ.
 */
export async function buildCommandEnvelope(
  operationType: string,
  payload: Record<string, unknown>,
): Promise<CommandEnvelope> {
  return {
    clientCommandId: crypto.randomUUID(),
    clientCreatedAt: new Date().toISOString(),
    operationType,
    payloadHash: await sha256Hex(stableStringify(payload)),
  };
}
