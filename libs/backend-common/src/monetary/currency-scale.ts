/**
 * Currency minor-unit scale registry.
 *
 * Maps ISO 4217 currency codes to the number of decimal digits
 * in their minor unit. For example USD has 2 decimal places (cents),
 * JPY has 0 (no minor unit), BHD has 3 (fils).
 *
 * Used by Money.toMinorUnits() to convert decimal amounts to the
 * integer representation expected by payment processors like Stripe.
 */
import Decimal from 'decimal.js';

/** @internal */
const CURRENCY_SCALE_MAP: ReadonlyMap<string, number> = new Map<string, number>([
  // 2-decimal currencies (most common)
  ['USD', 2],
  ['EUR', 2],
  ['GBP', 2],
  ['TRY', 2],
  ['AUD', 2],
  ['CAD', 2],
  ['CHF', 2],
  ['CNY', 2],
  ['INR', 2],
  ['BRL', 2],
  ['MXN', 2],
  ['NOK', 2],
  ['SEK', 2],
  ['DKK', 2],
  ['PLN', 2],
  ['CZK', 2],
  ['HUF', 2],
  ['RON', 2],
  ['BGN', 2],
  ['HRK', 2],
  ['RUB', 2],
  ['ZAR', 2],
  ['SGD', 2],
  ['HKD', 2],
  ['NZD', 2],
  ['THB', 2],
  ['MYR', 2],
  ['PHP', 2],
  ['IDR', 2],
  ['AED', 2],
  ['SAR', 2],
  ['QAR', 2],
  ['EGP', 2],
  ['NGN', 2],
  ['KES', 2],

  // 0-decimal currencies
  ['JPY', 0],
  ['KRW', 0],
  ['VND', 0],
  ['CLP', 0],

  // 3-decimal currencies
  ['BHD', 3],
  ['JOD', 3],
  ['KWD', 3],
  ['OMR', 3],
  ['TND', 3],
]);

/**
 * Returns the minor-unit scale for a given ISO 4217 currency code.
 *
 * @param currency - ISO 4217 currency code (e.g. 'USD', 'JPY', 'BHD')
 * @returns Number of decimal digits in the currency's minor unit
 * @throws Error if the currency code is not registered
 */
export function getCurrencyScale(currency: string): number {
  const scale = CURRENCY_SCALE_MAP.get(currency.toUpperCase());
  if (scale === undefined) {
    throw new Error(
      `Unknown currency code "${currency}". ` +
      `Register it in currency-scale.ts before use.`,
    );
  }
  return scale;
}

/**
 * Checks whether a currency code is registered in the scale map.
 *
 * @param currency - ISO 4217 currency code
 * @returns true if the currency is known
 */
export function isSupportedCurrency(currency: string): boolean {
  return CURRENCY_SCALE_MAP.has(currency.toUpperCase());
}

/**
 * Round an amount to its currency's own minor unit.
 *
 * A 33.33% discount on €10.00 is €3.33, not €3.333, and on ¥1000 it is ¥333,
 * not ¥333.33. Half-up is the direction that favours the customer.
 *
 * This lives beside `getCurrencyScale` because it is the only correct way to
 * use it: two byte-identical copies had grown inside billing-service
 * (`discount-rules.ts` and `module-quote.ts`), which is how a rounding rule
 * drifts between the quote a customer is shown and the invoice they receive.
 */
export function roundToCurrency(amount: Decimal, currency: string): Decimal {
  return amount.toDecimalPlaces(getCurrencyScale(currency), Decimal.ROUND_HALF_UP);
}
