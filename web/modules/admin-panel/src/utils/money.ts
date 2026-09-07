/**
 * Rendering money that arrives as an exact decimal string.
 *
 * ADR-0013 moved every price onto `numeric(19,4)` columns and put exact decimal
 * strings on the wire. The browser must not turn one back into an IEEE-754
 * number and then do arithmetic on it — the totals it renders would stop
 * matching the invoice the server raises. These helpers only FORMAT: they
 * widen once, at the last moment, for display.
 *
 * They also replace the per-page copies that hardcoded `currency: 'USD'` and
 * `minimumFractionDigits: 0`, which rendered a $19.99 plan as "$20".
 */

/** The minor-unit count for an ISO-4217 code; 2 covers everything else. */
const MINOR_UNITS: Readonly<Record<string, number>> = {
  BHD: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

export function currencyScale(currency: string): number {
  return MINOR_UNITS[currency.toUpperCase()] ?? 2;
}

/**
 * A decimal string as an amount in its own currency, with that currency's
 * symbol and its own number of minor units.
 */
export function formatCurrencyAmount(amount: string | undefined, currency: string): string {
  const scale = currencyScale(currency);
  return Number(amount ?? '0').toLocaleString(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
}

/** A decimal string as a bare number, for a place that prints its own symbol. */
export function formatDecimalAmount(amount: string | undefined, scale = 2): string {
  return Number(amount ?? '0').toLocaleString(undefined, {
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
}
