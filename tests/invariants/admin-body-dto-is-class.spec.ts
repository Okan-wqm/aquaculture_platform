/**
 * INVARIANT — every admin request body is a validated class
 * (CONTRACT-CRITICAL-003, ADR-0015).
 *
 * An `interface`-typed `@Body()` compiles to `design:paramtypes = Object`.
 * `ValidationPipe` then skips the parameter — `whitelist` strips nothing,
 * `forbidNonWhitelisted` rejects nothing, no `@IsString` runs — and
 * `SwaggerModule` emits an empty schema for it. Twenty-one admin routes were
 * in that state, including the billing plan catalogue, the messaging legal
 * hold and the retention window: any JSON at all reached the service.
 *
 * Generating the FE↔BE contract from those routes would produce `{}` and a
 * vacuously green gate, which is why the ADR makes class DTOs the hard
 * precondition for the OpenAPI artifact rather than a later clean-up.
 *
 * Rules over admin-api controllers:
 *   1. An unkeyed `@Body()` / `@Query()` binds the whole payload, so its type
 *      must resolve to a `class`. `@Body('key')` picks one property out and is
 *      not a DTO.
 *   2. That class must carry at least one class-validator decorator, on itself
 *      or on a class it extends — a class with no validators re-arms nothing.
 *   3. A type that cannot be resolved fails: the gate does not assume.
 *
 * Resolution (imports, barrels, path aliases) is
 * `tests/invariants/lib/dto-resolution.ts`.
 */
import { listAdminSourceFiles } from './lib/admin-route-table';
import {
  hasValidatorDecorator,
  requestDtoParametersIn,
  resolveDeclaration,
  REPO_ROOT,
  type RequestDtoParameter,
} from './lib/dto-resolution';

import { resolve } from 'node:path';

function allRequestDtoParameters(): RequestDtoParameter[] {
  return listAdminSourceFiles()
    .filter((file) => file.endsWith('.controller.ts'))
    .flatMap(requestDtoParametersIn);
}

describe('INVARIANT (CONTRACT-CRITICAL-003): every admin request body is a validated class', () => {
  const parameters = allRequestDtoParameters();
  const whole = parameters.filter((parameter) => !parameter.keyed);

  it('sees the admin request surface', () => {
    expect(parameters.length).toBeGreaterThan(100);
    expect(whole.length).toBeGreaterThan(50);
  });

  it('resolves every whole-payload @Body() / @Query() to a class', () => {
    const offenders = whole
      .filter((parameter) => parameter.kind !== 'class')
      .map(
        (parameter) =>
          `${parameter.id} at ${parameter.file}:${parameter.line} is ${parameter.kind} (${parameter.typeText})`,
      )
      .sort();
    expect(offenders).toEqual([]);
  });

  it('arms validation on every one of those classes', () => {
    const unarmed: string[] = [];
    for (const parameter of whole) {
      if (parameter.kind !== 'class' || parameter.declaredIn === null) continue;
      const typeName = parameter.typeText.replace(/<.*/, '').trim();
      const resolved = resolveDeclaration(resolve(REPO_ROOT, parameter.file), typeName);
      if (!resolved.node || !resolved.file) {
        unarmed.push(`${parameter.id}: ${typeName} could not be re-resolved`);
        continue;
      }
      if (!hasValidatorDecorator(resolved.node, resolved.file)) {
        unarmed.push(`${parameter.id}: ${typeName} carries no class-validator decorator`);
      }
    }
    expect(unarmed.sort()).toEqual([]);
  });

  describe('resolution', () => {
    it('follows an import to the class it names, and reports an interface as an interface', () => {
      const controller = resolve(
        REPO_ROOT,
        'apps/admin-api-service/src/billing/billing.controller.ts',
      );
      expect(resolveDeclaration(controller, 'CreatePlanDto').kind).toBe('class');
      expect(resolveDeclaration(controller, 'CustomPlanFilter').kind).toBe('interface');
      expect(resolveDeclaration(controller, 'NoSuchTypeAnywhere').kind).toBe('unresolved');
    });

    it('counts a validator inherited from a base class', () => {
      const dto = resolve(REPO_ROOT, 'apps/admin-api-service/src/billing/dto/billing.dto.ts');
      const derived = resolveDeclaration(dto, 'CreateDiscountCodeDto');
      expect(derived.kind).toBe('class');
      expect(
        derived.node && derived.file && hasValidatorDecorator(derived.node, derived.file),
      ).toBe(true);
    });
  });
});
