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

/** Özyinelemeli anahtar-sıralı JSON — mobil kuyruğun stableStringify paritesi. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
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
