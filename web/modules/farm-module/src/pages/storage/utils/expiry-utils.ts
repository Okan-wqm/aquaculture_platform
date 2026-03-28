/**
 * Expiry date utilities for storage inventory display.
 *
 * Centralised helpers for determining visual urgency of inventory rows
 * based on expiry date proximity. Used by GenericStockTab and any future
 * component that needs expiry-based row colouring.
 */

/**
 * Number of days before expiry that triggers the "expiring soon" warning.
 * Aligned with HACCP Critical Control Point guidance for perishable
 * aquaculture supplies (feed, chemicals, medications).
 */
const EXPIRY_WARNING_DAYS = 30;

/**
 * Determines the Tailwind CSS background class for an inventory row
 * based on its expiry date proximity.
 *
 * - Red (`bg-red-50`):  expired — safety hazard, must be disposed or used immediately.
 * - Amber (`bg-amber-50`): expiring within 30 days — plan to use or risk waste.
 * - Empty string: normal, no urgency.
 *
 * @param expiryDate - ISO date string, or undefined if the item has no expiry.
 * @returns Tailwind background class or empty string.
 */
export function getExpiryRowClass(expiryDate?: string): string {
  if (!expiryDate) return '';

  const expiry = new Date(expiryDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (expiry < today) return 'bg-red-50';

  const warningDate = new Date(today);
  warningDate.setDate(warningDate.getDate() + EXPIRY_WARNING_DAYS);

  if (expiry <= warningDate) return 'bg-amber-50';

  return '';
}

/**
 * Checks whether an expiry date is in the past (expired).
 *
 * @param expiryDate - ISO date string.
 * @returns `true` if the date is before today at midnight.
 */
export function isExpired(expiryDate: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(expiryDate) < today;
}

/**
 * Checks whether an expiry date falls within the warning window (30 days)
 * but is not yet expired.
 *
 * @param expiryDate - ISO date string.
 * @returns `true` if the date is within the next 30 days.
 */
export function isExpiringSoon(expiryDate: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expiry = new Date(expiryDate);
  if (expiry < today) return false;

  const warningDate = new Date(today);
  warningDate.setDate(warningDate.getDate() + EXPIRY_WARNING_DAYS);

  return expiry <= warningDate;
}
