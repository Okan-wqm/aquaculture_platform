// Money value object — immutable, arbitrary-precision monetary arithmetic
export { Money } from './money';
export type { MoneyJSON } from './money';

// Currency scale registry — ISO 4217 minor-unit mappings
export { getCurrencyScale, isSupportedCurrency, roundToCurrency } from './currency-scale';

// TypeORM decorator & transformer — lossless Decimal ↔ PostgreSQL numeric
export { MoneyColumn, DecimalValueTransformer } from './decimal-column.decorator';
export type { MoneyColumnOptions } from './decimal-column.decorator';
