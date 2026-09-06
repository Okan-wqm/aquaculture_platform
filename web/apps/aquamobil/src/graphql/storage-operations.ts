// ============================================================================
// AquaMobil storage GraphQL operations — S1-CODEGEN
// ============================================================================
// The storage pages (stock view, movement, transfer) used to each carry their
// own copy of these queries. graphql-codegen requires operation names to be
// unique per client, so a single declaration lives here and the pages import
// it; the queued storage MUTATIONS live only in pwa/operation-registry.ts
// (P-23) and are imported from the generated module.

import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { gql } from 'graphql-tag';

import type {
  StockAtLocationQuery,
  StockAtLocationQueryVariables,
  StorageInventoryItemsQuery,
  StorageInventoryItemsQueryVariables,
  StorageLocationsQuery,
  StorageLocationsQueryVariables,
} from '@/generated/graphql';

/**
 * Storage items filtered by item type. The backend returns items relevant to
 * the tenant's warehouse inventory (feed brands, chemical products, etc.).
 */
export const STORAGE_INVENTORY_ITEMS: TypedDocumentNode<
  StorageInventoryItemsQuery,
  StorageInventoryItemsQueryVariables
> = gql`
  query StorageInventoryItems($itemType: StorageItemType) {
    storageInventory(itemType: $itemType, limit: 100) {
      itemId
      itemName
      unit
      itemType
    }
  }
`;

/** Storage locations (warehouses, silos, cold stores, …) for the tenant. */
export const STORAGE_LOCATIONS: TypedDocumentNode<
  StorageLocationsQuery,
  StorageLocationsQueryVariables
> = gql`
  query StorageLocations {
    storageLocations {
      items {
        id
        name
        code
      }
    }
  }
`;

/**
 * Stock at a specific location. Backed by the farm-service
 * `storageInventory(locationId: ID)` query (StorageResolver), which returns a
 * flat list of StorageInventoryResponse rows for the location.
 */
export const STOCK_AT_LOCATION: TypedDocumentNode<
  StockAtLocationQuery,
  StockAtLocationQueryVariables
> = gql`
  query StockAtLocation($locationId: ID!) {
    storageInventory(locationId: $locationId) {
      id
      itemName
      itemType
      quantity
      unit
      lotNumber
      expiryDate
    }
  }
`;
