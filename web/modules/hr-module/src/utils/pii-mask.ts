/**
 * PII masking utilities for the HR module frontend.
 *
 * HR-HIGH-017: National ID (TC kimlik) must be displayed with only the
 * last 4 digits visible. These functions ensure PII is never displayed
 * in full to users with basic HR module access.
 */

/**
 * Mask a national ID / government ID, showing only the last 4 characters.
 *
 * @param nationalId - Full national ID string
 * @returns Masked string like "***-****-1234" or the original if too short
 *
 * @example
 * maskNationalId('12345678901') // '***-****-8901'
 * maskNationalId('ABC-123-4567') // '***-****-4567'
 * maskNationalId('') // ''
 */
export function maskNationalId(nationalId: string | undefined | null): string {
  if (!nationalId) return '';
  if (nationalId.length <= 4) return nationalId;

  const lastFour = nationalId.slice(-4);
  return `***-****-${lastFour}`;
}

/**
 * Mask an email address, showing only the first character and domain.
 *
 * @param email - Full email address
 * @returns Masked string like "j***@example.com"
 */
export function maskEmail(email: string | undefined | null): string {
  if (!email) return '';
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return '***';
  return `${email[0]}***${email.slice(atIndex)}`;
}

/**
 * Mask a phone number, showing only the last 4 digits.
 *
 * @param phone - Full phone number
 * @returns Masked string like "***-****-5678"
 */
export function maskPhone(phone: string | undefined | null): string {
  if (!phone) return '';
  const digitsOnly = phone.replace(/\D/g, '');
  if (digitsOnly.length <= 4) return phone;
  return `***-****-${digitsOnly.slice(-4)}`;
}
