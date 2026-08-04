/**
 * useErrorMessage / parseGraphQLError
 * ================================================================
 *
 * Centralised parsing for GraphQL errors the farm-service backend
 * emits. The backend's `AllExceptionsFilter` wraps structured errors
 * with `extensions.code` (e.g. `BATCH_WITHDRAWAL_BLOCKED`) plus an
 * optional `extensions.userMessage` Turkish sentence.
 *
 * # Why one place
 *
 * Before this module, `CloseBatchModal.parseWithdrawalBlock` was the
 * only handler that dug into `extensions.code`. Every new Tier 2/3
 * modal would reinvent the same parsing — a classic "300 inline
 * try/catch" anti-pattern. The hook + `parseGraphQLError` function
 * extract it once.
 *
 * # Scope
 *
 * - `parseGraphQLError(err)` — pure function, no React. Returns
 *   `{ code?, message, extensions? }`. Useful inside mutation
 *   `onError` handlers and in tests.
 * - `formatErrorForToast(err)` — string helper for the common
 *   "show a toast with the localised message" case.
 * - Turkish copy is **hardcoded** here in this phase. When Scope B
 *   Phase I2 (backend i18n) lands, the error-code map becomes a
 *   translation key per code; callers stay the same. See the Scope B
 *   plan under `docs/plans/2026-04-24-*` for the migration path.
 */
import { useCallback } from 'react';

/**
 * The shape every error consumer in the farm-module can rely on.
 * `code` is the server-stamped `extensions.code`; `message` is the
 * user-facing Turkish sentence (localised via the error-code map
 * below, falling back to the raw server message).
 */
export interface ParsedGraphQLError {
  code?: string;
  message: string;
  extensions?: Record<string, unknown>;
}

/**
 * Hand-curated map: `extensions.code` → user-facing Turkish string.
 *
 * New entries land here when a Tier 2/3 mutation surfaces a new
 * structured error. When the corresponding backend error is
 * raised via `FarmAppError` with a specific code, ADD it to this
 * map before the frontend PR merges — undocumented codes fall
 * through to the raw message surface, which is a worse UX.
 */
const ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  // Tier 1 + 2 domain errors
  BATCH_WITHDRAWAL_BLOCKED:
    'Parti aktif ilaç kesintisi nedeniyle bu işlem yapılamaz. ' +
    'Onay için aktif tedavileri görüntüleyin.',
  BATCH_NOT_FOUND: 'Parti bulunamadı. Sayfayı yenileyin.',
  BATCH_VERSION_MISMATCH:
    'Parti başka bir oturumda güncellenmiş — sayfayı yenileyin ve tekrar deneyin.',
  FEED_ASSIGNMENT_NOT_FOUND: 'Yem ataması bulunamadı.',
  FEED_ASSIGNMENT_IN_USE:
    'Bu yem ataması aktif yemleme kayıtlarında kullanılıyor — önce ' +
    'ilgili yemleme kayıtlarını düzenleyin.',
  FEED_NOT_FOUND: 'Seçilen yem bulunamadı.',
  METER_READING_NOT_INCREASING:
    'Sayaç okuması geriye gidemez — son bakım sayaç değerinden büyük olmalı.',
  SCHEDULE_NOT_ACTIVE: 'Bu planlama aktif değil — önce aktive edin.',
  SCHEDULE_NOT_METER_BASED: 'Bu planlama sayaç tabanlı değil.',
  SCHEDULE_HAS_OPEN_WORK_ORDER:
    'Bu planlama için zaten açık bir iş emri var — önce o iş emrini tamamlayın.',
  CHECKLIST_INCOMPLETE: 'Zorunlu checklist maddeleri tamamlanmadan bakım kapatılamaz.',
  AUTO_GENERATE_THROTTLED:
    'Otomatik iş emri üretimi az önce çalıştırıldı. ' +
    'Lütfen birkaç dakika bekleyip tekrar deneyin.',
  SUB_EQUIPMENT_IN_USE:
    'Bu alt ekipman aktif bir operasyonda kullanılıyor — önce ilgili kayıtları düzenleyin.',
  // Generic fall-throughs
  TANK_CAPACITY_EXCEEDED:
    'Tank kapasitesi aşıldı — başka bir tank seçin veya mevcut partiyi hareket ettirin.',
  BACKDATE_BLOCKED: 'Geriye dönük tarih politikası bu işleme izin vermiyor.',
  VALIDATION_ERROR: 'Giriş doğrulaması başarısız — alanları kontrol edin.',
});

/**
 * Parse an unknown error value (usually from a React Query mutation
 * `onError` callback) into the standard shape. Handles:
 *
 *   - Apollo-style / graphql-request errors with `response.errors[]`
 *   - Network errors with just a `message`
 *   - Arbitrary thrown values — returns a safe fallback message
 *
 * Never throws.
 */
export function parseGraphQLError(err: unknown): ParsedGraphQLError {
  if (err === null || err === undefined) {
    return { message: 'Beklenmeyen bir hata oluştu.' };
  }

  // graphql-request puts server errors under `response.errors[]`.
  const errAny = err as {
    response?: {
      errors?: Array<{
        message?: string;
        extensions?: Record<string, unknown>;
      }>;
    };
    message?: string;
  };

  const firstServerError = errAny.response?.errors?.[0];
  if (firstServerError) {
    const extensions = firstServerError.extensions ?? {};
    const code = typeof extensions.code === 'string' ? extensions.code : undefined;
    const mappedMessage = code ? ERROR_CODE_MESSAGES[code] : undefined;
    return {
      code,
      message:
        mappedMessage ??
        (typeof extensions.userMessage === 'string'
          ? extensions.userMessage
          : (firstServerError.message ?? 'Sunucu hatası.')),
      extensions,
    };
  }

  // Plain Error — no server response (network failure, etc.)
  if (typeof errAny.message === 'string') {
    return { message: errAny.message };
  }

  return { message: 'Beklenmeyen bir hata oluştu.' };
}

/**
 * Convenience wrapper: returns just the user-facing message string,
 * perfect for passing to `toast.error(...)`.
 */
export function formatErrorForToast(err: unknown): string {
  return parseGraphQLError(err).message;
}

/**
 * React hook returning the same primitives — `useCallback` so the
 * reference is stable and safe to pass as a dependency in `useMemo` /
 * `useEffect`.
 */
export function useErrorMessage() {
  const parse = useCallback(parseGraphQLError, []);
  const format = useCallback(formatErrorForToast, []);
  return { parse, format };
}
