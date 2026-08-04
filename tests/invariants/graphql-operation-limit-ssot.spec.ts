import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('GraphQL operation-limit SSoT', () => {
  it('installs the same shared fragment-aware plugin at gateway and farm boundaries', () => {
    for (const appModule of [
      'apps/gateway-api/src/app.module.ts',
      'apps/farm-service/src/app.module.ts',
    ]) {
      const source = read(appModule);

      expect(source).toContain("from '@aquaculture/backend-common/graphql'");
      expect(source).toContain('createGraphqlOperationLimitPlugin({');
      expect(source).toContain('ENVIRONMENT_READ_OPERATION_FIELD_LIMITS');
      expect(source).not.toContain('graphql-alias-limit.plugin');
    }
  });

  it('keeps the AST collector in backend-common with no gateway-local duplicate', () => {
    const sharedSource = read('libs/backend-common/src/graphql/graphql-operation-limit.plugin.ts');

    expect(sharedSource).toContain('Kind.INLINE_FRAGMENT');
    expect(sharedSource).toContain('definition.kind === Kind.FRAGMENT_DEFINITION');
    expect(sharedSource).toContain('getOperationAST(document, operationName ?? undefined)');
    expect(
      existsSync(join(REPO_ROOT, 'apps/gateway-api/src/plugins/graphql-alias-limit.plugin.ts')),
    ).toBe(false);
  });
});
