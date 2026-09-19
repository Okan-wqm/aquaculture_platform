import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { findAiPersona } from '@aquaculture/shared-contracts';

/**
 * `aiPersona` must be a PUBLISHED persona id from the shared catalogue
 * (AISAFETY-MEDIUM-024). The previous grammar-only regex let a channel be
 * created with an id every turn would then reject; the catalogue is the same
 * SSoT ai-service resolves against, so an AI channel can only ever pin a
 * persona that exists. `null`/`undefined` stay valid: they mean "the tenant's
 * default persona".
 */
export function IsKnownAiPersonaId(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isKnownAiPersonaId',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (value === null || value === undefined) return true;
          return typeof value === 'string' && findAiPersona(value) !== undefined;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a published AI persona id (e.g. "expert-farm-production-v1")`;
        },
      },
    });
  };
}
