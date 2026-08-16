import Decimal from 'decimal.js';

import { getCurrencyScale } from './currency-scale';

// IMPORTANT: Configure Decimal.js for financial-grade precision.
// Banker's rounding (ROUND_HALF_EVEN) eliminates the upward bias
// of the default ROUND_HALF_UP and is required by ISO 4217 / EU PSD2.
Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN,
});

/**
 * Serialised form of a Money value, safe for JSON transport and DB storage.
 */
export interface MoneyJSON {
  /** Exact decimal string, e.g. "99.99" */
  readonly amount: string;
  /** ISO 4217 currency code, e.g. "USD" */
  readonly currency: string;
}

/**
 * Immutable Money value object.
 *
 * Prevents all JavaScript floating-point arithmetic on monetary values.
 * Every arithmetic method returns a **new** Money instance — never mutates.
 *
 * @example
 * ```typescript
 * const price = Money.of(99.99, 'USD');
 * const tax   = price.multiply(0.08);
 * const total = price.add(tax);
 * const cents = total.toMinorUnits(); // integer for Stripe
 * ```
 *
 * Design decisions:
 * - Private constructor forces callers through factory methods so we
 *   can validate invariants in a single place.
 * - Currency mismatch on add/subtract throws immediately — silent
 *   conversion would mask bugs.
 * - Default rounding is ROUND_HALF_EVEN (banker's rounding) per ISO 4217.
 */
export class Money {
  /** @internal exact decimal amount */
  private readonly _amount: Decimal;
  /** @internal upper-cased ISO 4217 code */
  private readonly _currency: string;

  // ── Constructor (private) ────────────────────────────────────────
  private constructor(amount: Decimal, currency: string) {
    this._amount = amount;
    this._currency = currency.toUpperCase();
  }

  // ── Factory Methods ──────────────────────────────────────────────

  /**
   * Creates a Money instance from a numeric value.
   *
   * @param amount   - The monetary amount (number, string, or Decimal)
   * @param currency - ISO 4217 currency code
   * @returns A new immutable Money instance
   * @throws Error if the currency code is not registered
   */
  static of(amount: number | string | Decimal, currency: string): Money {
    const upperCurrency = currency.toUpperCase();
    // Validate currency is known (will throw if not)
    getCurrencyScale(upperCurrency);
    const decimal = amount instanceof Decimal ? amount : new Decimal(amount);
    return new Money(decimal, upperCurrency);
  }

  /**
   * Creates a Money instance from minor units (e.g. cents for USD).
   *
   * This is the inverse of toMinorUnits() and is intended for converting
   * values received from payment processors like Stripe.
   *
   * @param minorUnits - Integer amount in minor units (e.g. 9999 = $99.99)
   * @param currency   - ISO 4217 currency code
   * @returns A new immutable Money instance
   * @throws Error if minorUnits is not an integer
   */
  static fromMinorUnits(minorUnits: number, currency: string): Money {
    if (!Number.isInteger(minorUnits)) {
      throw new Error(`minorUnits must be an integer, received ${minorUnits}`);
    }
    const upperCurrency = currency.toUpperCase();
    const scale = getCurrencyScale(upperCurrency);
    const decimal = new Decimal(minorUnits).dividedBy(new Decimal(10).pow(scale));
    return new Money(decimal, upperCurrency);
  }

  /**
   * Reconstructs a Money instance from its JSON representation.
   *
   * @param json - Serialised Money object
   * @returns A new immutable Money instance
   */
  static fromJSON(json: MoneyJSON): Money {
    return Money.of(json.amount, json.currency);
  }

  /**
   * Creates a zero-value Money for the given currency.
   *
   * @param currency - ISO 4217 currency code
   * @returns Money representing 0 in the specified currency
   */
  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  // ── Getters ──────────────────────────────────────────────────────

  /** ISO 4217 currency code (always upper-case). */
  get currency(): string {
    return this._currency;
  }

  // ── Arithmetic ───────────────────────────────────────────────────

  /**
   * Adds another Money value to this one.
   *
   * @param other - Money to add
   * @returns New Money with the sum
   * @throws Error if currencies differ
   */
  add(other: Money): Money {
    this.assertSameCurrency(other, 'add');
    return new Money(this._amount.plus(other._amount), this._currency);
  }

  /**
   * Subtracts another Money value from this one.
   *
   * @param other - Money to subtract
   * @returns New Money with the difference
   * @throws Error if currencies differ
   */
  subtract(other: Money): Money {
    this.assertSameCurrency(other, 'subtract');
    return new Money(this._amount.minus(other._amount), this._currency);
  }

  /**
   * Multiplies this Money by a scalar factor.
   *
   * @param factor - Multiplication factor
   * @returns New Money with the product
   */
  multiply(factor: number | Decimal): Money {
    const f = factor instanceof Decimal ? factor : new Decimal(factor);
    return new Money(this._amount.times(f), this._currency);
  }

  /**
   * Divides this Money by a scalar divisor.
   *
   * @param divisor      - Division divisor (must not be zero)
   * @param roundingMode - Optional rounding mode override (default: ROUND_HALF_EVEN)
   * @returns New Money with the quotient
   * @throws Error if divisor is zero
   */
  divide(divisor: number | Decimal, roundingMode?: Decimal.Rounding): Money {
    const d = divisor instanceof Decimal ? divisor : new Decimal(divisor);
    if (d.isZero()) {
      throw new Error('Cannot divide Money by zero');
    }
    const prevRounding = Decimal.rounding;
    if (roundingMode !== undefined) {
      Decimal.set({ rounding: roundingMode });
    }
    try {
      const result = this._amount.dividedBy(d);
      return new Money(result, this._currency);
    } finally {
      if (roundingMode !== undefined) {
        Decimal.set({ rounding: prevRounding });
      }
    }
  }

  /**
   * Returns the absolute value of this Money.
   *
   * @returns New Money with absolute amount
   */
  abs(): Money {
    return new Money(this._amount.abs(), this._currency);
  }

  /**
   * Negates this Money value.
   *
   * @returns New Money with negated amount
   */
  negate(): Money {
    return new Money(this._amount.negated(), this._currency);
  }

  // ── Comparison ───────────────────────────────────────────────────

  /**
   * Checks equality with another Money value (amount AND currency).
   *
   * @param other - Money to compare with
   * @returns true if both amount and currency are identical
   */
  equals(other: Money): boolean {
    return this._currency === other._currency && this._amount.equals(other._amount);
  }

  /** Returns true if the amount is exactly zero. */
  isZero(): boolean {
    return this._amount.isZero();
  }

  /** Returns true if the amount is strictly negative. */
  isNegative(): boolean {
    return this._amount.isNegative();
  }

  /** Returns true if the amount is strictly positive. */
  isPositive(): boolean {
    return this._amount.isPositive() && !this._amount.isZero();
  }

  /**
   * Compares this Money with another of the same currency.
   *
   * @param other - Money to compare with
   * @returns -1, 0, or 1
   * @throws Error if currencies differ
   */
  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other, 'compareTo');
    return this._amount.comparedTo(other._amount) as -1 | 0 | 1;
  }

  /**
   * Returns true if this Money is greater than the other.
   *
   * @param other - Money to compare with
   * @throws Error if currencies differ
   */
  greaterThan(other: Money): boolean {
    return this.compareTo(other) === 1;
  }

  /**
   * Returns true if this Money is less than the other.
   *
   * @param other - Money to compare with
   * @throws Error if currencies differ
   */
  lessThan(other: Money): boolean {
    return this.compareTo(other) === -1;
  }

  // ── Conversion ───────────────────────────────────────────────────

  /**
   * Converts to integer minor units for payment processors (e.g. Stripe).
   *
   * # Why this method returns `number` (NOT bigint)
   *
   * BACKWARD COMPATIBILITY ONLY. New code should use
   * `toMinorUnitsBigInt()` which returns `bigint` and is precision-
   * safe across the full Decimal range. PLAT-LOW-001 captured the
   * gap: Number.MAX_SAFE_INTEGER is 2^53-1 (~9 quadrillion); for
   * low-denominator currencies (JPY, INR, KRW, IDR — no minor units
   * means the integer is the full amount) a tenant invoicing in JPY
   * for ~9 quadrillion yen would silently lose precision at this
   * conversion. The same case for high-volume metered billing
   * (millions of API calls × fractions of a cent) accumulates large
   * minor-unit totals.
   *
   * Rounds to the currency's minor-unit scale using banker's rounding,
   * then converts to a plain integer.
   *
   * @returns Integer minor units as `number` — may lose precision above 2^53-1
   * @deprecated Use {@link toMinorUnitsBigInt} for precision-safe conversion
   */
  toMinorUnits(): number {
    const scale = getCurrencyScale(this._currency);
    const shifted = this._amount.times(new Decimal(10).pow(scale));
    return shifted.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
  }

  /**
   * Converts to integer minor units as a `bigint` — precision-safe
   * across the full Decimal range.
   *
   * Use this method for any code path that touches:
   *   - Payment-processor SDKs that accept bigint (Stripe MeterEvent
   *     `value` field; Stripe Refund `amount` in some SDK versions)
   *   - Internal Money pipelines (Stripe outbound at libs/backend-common/
   *     src/billing/stripe-api.types.ts uses bigint everywhere)
   *   - Aggregations (sum-of-charges over a long period easily exceeds
   *     Number.MAX_SAFE_INTEGER for low-denominator currencies)
   *
   * @returns Integer minor units as `bigint`
   */
  toMinorUnitsBigInt(): bigint {
    const scale = getCurrencyScale(this._currency);
    const shifted = this._amount.times(new Decimal(10).pow(scale));
    // Decimal.js → bigint: round first, then format as a base-10 string,
    // then construct bigint. This avoids any intermediate float coercion.
    const rounded = shifted.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
    return BigInt(rounded.toFixed(0));
  }

  /**
   * Returns the underlying Decimal value for precise arithmetic chains.
   *
   * @returns Decimal.js instance (immutable copy)
   */
  toDecimal(): Decimal {
    return new Decimal(this._amount);
  }

  /**
   * Returns a human-readable string: "99.99 USD".
   *
   * @returns Formatted string with amount and currency
   */
  toString(): string {
    const scale = getCurrencyScale(this._currency);
    return `${this._amount.toFixed(scale)} ${this._currency}`;
  }

  /**
   * Returns a JSON-safe representation for serialisation.
   *
   * @returns Object with exact string amount and currency code
   */
  toJSON(): MoneyJSON {
    return {
      amount: this._amount.toString(),
      currency: this._currency,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Asserts that the other Money has the same currency.
   * @internal
   */
  private assertSameCurrency(other: Money, operation: string): void {
    if (this._currency !== other._currency) {
      throw new Error(
        `Currency mismatch in ${operation}: ` +
          `cannot combine ${this._currency} with ${other._currency}. ` +
          `Convert currencies explicitly before arithmetic.`,
      );
    }
  }
}
