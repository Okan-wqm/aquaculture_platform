/**
 * `@TenantParam('query')` contributes its parameter to the OpenAPI document
 * (ADMIN-HIGH-149).
 *
 * The `@nestjs/swagger` plugin reads `@Query()` and nothing else, so for as
 * long as this decorator was only a parameter decorator, all 32 query-sourced
 * call sites in admin-api documented NO tenant parameter — while
 * `VerifiedTenantPipe` refused any request that omitted it with
 * `BadRequestException('tenantId is required')`. A client generated from that
 * contract could not know the one parameter it had to send, and two admin
 * pages shipped calls that could only ever 400
 * (ADMIN-CRITICAL-147, ADMIN-CRITICAL-150).
 *
 * These assertions read the same metadata key the swagger module reads, so
 * they fail if the contribution is ever dropped — including by a refactor that
 * "simplifies" the decorator back to a bare `createParamDecorator`.
 */
import { TenantParam } from '../tenant-param.decorator';

/**
 * The metadata key `@nestjs/swagger` stores route parameters under —
 * `DECORATORS.API_PARAMETERS` in `@nestjs/swagger/dist/constants`. Spelled out
 * rather than imported: that module ships only a `.d.ts` beside its CommonJS
 * build, and importing it resolves to the declaration file, which Jest cannot
 * parse.
 */
const API_PARAMETERS = 'swagger/apiParameters';

interface DocumentedParameter {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly format?: string;
  readonly description?: string;
}

/** The parameters the swagger module would read off one handler. */
function documentedParameters(handler: (...args: never[]) => unknown): DocumentedParameter[] {
  return (Reflect.getMetadata(API_PARAMETERS, handler) ?? []) as DocumentedParameter[];
}

describe('@TenantParam OpenAPI contribution (ADMIN-HIGH-149)', () => {
  it('documents a required uuid query parameter for the default form', () => {
    class Controller {
      read(@TenantParam('query') _tenantId: string): void {
        void _tenantId;
      }
    }

    const [parameter, ...rest] = documentedParameters(Controller.prototype.read);
    expect(rest).toHaveLength(0);
    expect(parameter).toMatchObject({
      name: 'tenantId',
      in: 'query',
      required: true,
      format: 'uuid',
    });
    expect(parameter?.description).toContain('refused without it');
  });

  it('documents an optional one as optional, and says so', () => {
    class Controller {
      read(@TenantParam('query', { optional: true }) _tenantId?: string): void {
        void _tenantId;
      }
    }

    const [parameter] = documentedParameters(Controller.prototype.read);
    expect(parameter).toMatchObject({ name: 'tenantId', in: 'query', required: false });
    expect(parameter?.description).toContain('omit to act across tenants');
  });

  it('documents the caller-supplied key rather than assuming `tenantId`', () => {
    class Controller {
      read(@TenantParam('query', { key: 'ownerId' }) _ownerId: string): void {
        void _ownerId;
      }
    }

    expect(documentedParameters(Controller.prototype.read)[0]).toMatchObject({
      name: 'ownerId',
      in: 'query',
    });
  });

  it('adds nothing for a path-sourced id, which the route template already declares', () => {
    class Controller {
      read(@TenantParam('param') _tenantId: string): void {
        void _tenantId;
      }
    }

    expect(documentedParameters(Controller.prototype.read)).toHaveLength(0);
  });

  it('adds nothing for a body-sourced id, which TenantIdCarrier declares on the DTO', () => {
    class Controller {
      write(@TenantParam('body') _tenantId: string): void {
        void _tenantId;
      }
    }

    expect(documentedParameters(Controller.prototype.write)).toHaveLength(0);
  });

  it('documents both when one handler takes two query-sourced ids', () => {
    class Controller {
      read(
        @TenantParam('query') _tenantId: string,
        @TenantParam('query', { key: 'sourceTenantId' }) _sourceTenantId: string,
      ): void {
        void _tenantId;
        void _sourceTenantId;
      }
    }

    const names = documentedParameters(Controller.prototype.read)
      .map((parameter) => parameter.name)
      .sort();
    expect(names).toEqual(['sourceTenantId', 'tenantId']);
  });
});
