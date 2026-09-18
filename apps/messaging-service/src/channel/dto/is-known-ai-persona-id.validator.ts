/**
 * FARM-AI PR-0 (Sprint 1.1) — channel aiPersona validation migration.
 *
 * Replaces the loose `@Matches(/^[a-z][a-z0-9-]*-v\d+$/)` grammar regex with
 * a CATALOGUE-membership check on top of the shared-contracts grammar. The
 * old regex accepted any specialty token (`operator-bogus-v1`), pushing the
 * "unknown persona" failure to chat time inside ai-service. With the frozen
 * catalogue in @aquaculture/shared-contracts, channel creation now fails
 * fast at the trust boundary with an actionable message.
 *
 * Catalogue membership only — per-tenant ENTITLEMENT (farm module, tier
 * permission) is deliberately NOT checked here; that is the server-side
 * permission filter on the persona listing + bridge path (PR-6).
 */
import {
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
} from 'class-validator';
import { findAiPersona } from '@aquaculture/shared-contracts';

@ValidatorConstraint({ name: 'isKnownAiPersonaId', async: false })
export class IsKnownAiPersonaIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && findAiPersona(value) !== null;
  }

  defaultMessage(validationArguments?: ValidationArguments): string {
    return (
      `${validationArguments?.property} must be a known AI persona id ` +
      `(e.g. "operator-v1", "expert-farm-water-health-v1")`
    );
  }
}

export function IsKnownAiPersonaId(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isKnownAiPersonaId',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsKnownAiPersonaIdConstraint,
    });
  };
}
