/**
 * Feed Stock Tab - Thin wrapper around GenericStockTab for feed inventory.
 *
 * Columns: itemName, location, lotNumber, quantity, expiry.
 * Feed items require lot number (EU 178/2002) and expiry tracking (HACCP).
 */
import React from 'react';
import { StorageItemType } from '../../../hooks/useStorageInventory';
import { GenericStockTab } from './GenericStockTab';

export const FeedStockTab: React.FC = () => (
  <GenericStockTab
    itemType={StorageItemType.FEED}
    itemLabel="feeds"
    columns={['itemName', 'location', 'lotNumber', 'quantity', 'expiry']}
  />
);

export default FeedStockTab;
