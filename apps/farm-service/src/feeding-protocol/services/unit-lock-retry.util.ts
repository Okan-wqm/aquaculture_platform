/**
 * Ünite kilidi yarışında sınırlı yeniden deneme (FARM-MEDIUM-288).
 *
 * `BiomassGrowthApplierService.lockUnitForGrowth` kanonik sırayı korumak için
 * önce KİLİTSİZ bir önizleme okur, sonra batch'leri artan id sırasında
 * kilitler. İki okuma arasında ünitenin batch üyeliği değişirse (transfer,
 * stoklama, tam hasat) `ConflictException` fırlatır ve docblock'u "çağıran
 * transaction'ı yeniden dener" der — ama HİÇBİR çağıran denemiyordu: operatör
 * öğün kaydederken ham 409 alıyordu, üstelik hata kendi kendine geçen bir
 * yarıştan kaynaklandığı hâlde.
 *
 * Yeniden deneme TRANSACTION SINIRINDA yapılır (kilit tutarken değil): tx geri
 * alınır, kilitler bırakılır, yeni tx taze üyeliği okur. Aynı transaction
 * içinde yeniden kilitlemek, halihazırda tutulan kilitlerin üstüne DAHA KÜÇÜK
 * id'li bir batch kilidi istemeye yol açabilirdi — kanonik sıranın tam olarak
 * engellediği AB-BA penceresi.
 *
 * @module FeedingProtocol/Services
 */
import { ConflictException, Logger } from '@nestjs/common';

const DEFAULT_ATTEMPTS = 3;
const logger = new Logger('UnitLockRetry');

/** `lockUnitForGrowth`'un üyelik-yarışı hatası mı (diğer 409'lar geçilmez). */
export function isUnitMembershipConflict(error: unknown): boolean {
  return (
    error instanceof ConflictException &&
    typeof error.message === 'string' &&
    error.message.includes('batch membership changed')
  );
}

/**
 * `fn` KENDİ transaction'ını açmalıdır; üyelik yarışında tamamı yeniden
 * çalıştırılır. Deneme hakkı biterse hata olduğu gibi yükselir (sessiz
 * yutma yok — kalıcı bir tutarsızlık varsa görünür kalmalı).
 */
export async function withUnitLockRetry<T>(
  fn: () => Promise<T>,
  attempts: number = DEFAULT_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isUnitMembershipConflict(error)) throw error;
      lastError = error;
      logger.warn(
        `Unit batch membership changed during lock acquisition; retrying (${attempt}/${attempts}).`,
      );
    }
  }
  throw lastError;
}
