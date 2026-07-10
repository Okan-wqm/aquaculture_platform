/**
 * IsSupportedCurrency — class-validator constraint that accepts ONLY
 * currency codes registered in the platform monetary registry
 * (`isSupportedCurrency`, the exact set `Money` can operate on).
 *
 * A bare `/^[A-Z]{3}$/` regex passes syntactically-valid-but-unsupported
 * codes (e.g. `ZZZ`, or an ISO-4217 code like `ISK` that the registry
 * does not carry). Persisting such a code as the tenant currency SSoT
 * bricks every downstream `Money.of(...)` (it throws), which is
 * unrecoverable from the HR labour-cost surface. Validating at the write
 * boundary makes an unsupported tenant currency structurally impossible.
 */
import { isSupportedCurrency } from '@aquaculture/backend-common/monetary';
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isSupportedCurrency', async: false })
export class IsSupportedCurrencyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isSupportedCurrency(value);
  }

  defaultMessage(): string {
    return '$property must be a supported ISO 4217 currency code';
  }
}

export function IsSupportedCurrency(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsSupportedCurrencyConstraint,
    });
  };
}
