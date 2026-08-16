import { Kind, parse, type DocumentNode, type OperationTypeNode } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlatformConfigurationsDocument } from '../../generated/graphql';
import { executeAdminGraphql } from '../admin-graphql-client';

const sharedUi = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('@aquaculture/shared-ui', () => ({
  graphQLOperationIdentity: (
    document: DocumentNode,
  ): { readonly kind: OperationTypeNode; readonly name: string | null } => {
    const operations = document.definitions.filter(
      (definition) => definition.kind === Kind.OPERATION_DEFINITION,
    );
    if (operations.length !== 1) {
      throw new TypeError('test document must contain exactly one operation');
    }
    const operation = operations[0]!;
    return Object.freeze({
      kind: operation.operation,
      name: operation.name?.value ?? null,
    });
  },
  graphqlClient: Object.freeze({ request: sharedUi.request }),
}));

describe('executeAdminGraphql generated document authority', () => {
  beforeEach(() => {
    sharedUi.request.mockReset();
    sharedUi.request.mockResolvedValue({ effectiveConfigurationsByService: [] });
  });

  it('admits the exact generated document object from the compiled catalog', async () => {
    await expect(
      executeAdminGraphql(PlatformConfigurationsDocument, { service: 'platform' }),
    ).resolves.toEqual({ effectiveConfigurationsByService: [] });

    expect(sharedUi.request).toHaveBeenCalledWith(
      PlatformConfigurationsDocument,
      { service: 'platform' },
      undefined,
    );
    expect(Object.isFrozen(PlatformConfigurationsDocument)).toBe(true);
    expect(Object.isFrozen(PlatformConfigurationsDocument.definitions)).toBe(true);
  });

  it('rejects a reconstructed document even when its name, kind, and selections match', () => {
    const reconstructedDocument: typeof PlatformConfigurationsDocument = {
      ...PlatformConfigurationsDocument,
      definitions: [...PlatformConfigurationsDocument.definitions],
    };

    expect(() => executeAdminGraphql(reconstructedDocument, { service: 'platform' })).toThrow(
      'outside the exact generated document catalog',
    );
    expect(sharedUi.request).not.toHaveBeenCalled();
  });

  it('rejects a locally modified selection set that reuses a catalogued name and kind', () => {
    const modifiedDocument = parse(`
      query PlatformConfigurations($service: String!) {
        effectiveConfigurationsByService(service: $service) {
          key
        }
      }
    `);

    expect(() => executeAdminGraphql(modifiedDocument, { service: 'platform' })).toThrow(
      'outside the exact generated document catalog',
    );
    expect(sharedUi.request).not.toHaveBeenCalled();
  });
});
