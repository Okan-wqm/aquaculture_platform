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
import {
  canonicalWireJsonStringifyV1,
  mobileCommandPayloadSha256V1,
  type MobileCommandIdentityV1,
} from '@aquaculture/shared-contracts';

export { canonicalWireJsonStringifyV1 as stableStringify } from '@aquaculture/shared-contracts';

export interface CommandEnvelope<OperationType extends string = string> {
  clientCommandId: string;
  clientCreatedAt: string;
  operationType: OperationType;
  payloadHash: string;
  schemaVersion: MobileCommandIdentityV1<OperationType>['schemaVersion'];
}

export function hashCommandPayload(payload: unknown): string {
  return mobileCommandPayloadSha256V1(payload);
}

/**
 * Verilen komut yükü için tam zarf üretir. Retry'da AYNI zarf yeniden
 * gönderilmelidir (idempotent replay) — çağıran zarfı mutation süresince
 * saklar, her denemede yeniden ÜRETMEZ.
 */
export async function buildCommandEnvelope<OperationType extends string>(
  identity: MobileCommandIdentityV1<OperationType>,
  payload: Record<string, unknown>,
): Promise<CommandEnvelope<OperationType>> {
  return {
    clientCommandId: crypto.randomUUID(),
    clientCreatedAt: new Date().toISOString(),
    operationType: identity.operationType,
    payloadHash: hashCommandPayload(payload),
    schemaVersion: identity.schemaVersion,
  };
}
