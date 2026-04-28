/**
 * Storage Inventory Cursor Connection
 *
 * Concrete GraphQL ObjectTypes for the phase 5.1 cursor pagination
 * primitive. The primitive's `CursorEdge<T>` / `CursorPageInfo` are
 * declared abstract because `@nestjs/graphql` cannot emit generic
 * wrappers directly — each resolver that adopts cursor pagination
 * declares thin concrete subclasses here.
 *
 * This file is the reference shape other storage list resolvers will
 * copy when they migrate.
 */
import { ObjectType, Field } from '@nestjs/graphql';
import { CursorPageInfo } from '@aquaculture/backend-common/pagination';

import { StorageInventoryResponse } from './storage-inventory.response';

@ObjectType('StorageInventoryEdge')
export class StorageInventoryEdge {
  @Field()
  cursor!: string;

  @Field(() => StorageInventoryResponse)
  node!: StorageInventoryResponse;
}

/**
 * Concrete PageInfo emission — extending the abstract primitive so
 * the two fields (endCursor, hasNextPage) surface under a stable
 * name on the federated schema. Each resolver's connection owns its
 * own concrete subclass because GraphQL schema composition rejects
 * anonymous / re-declared types.
 */
@ObjectType('StorageInventoryCursorPageInfo')
export class StorageInventoryCursorPageInfo extends CursorPageInfo {}

@ObjectType('StorageInventoryCursorConnection')
export class StorageInventoryCursorConnection {
  @Field(() => [StorageInventoryEdge])
  edges!: StorageInventoryEdge[];

  @Field(() => StorageInventoryCursorPageInfo)
  pageInfo!: StorageInventoryCursorPageInfo;
}
