/**
 * Chemicals Stock Tab - Thin wrapper around GenericStockTab for chemical inventory.
 *
 * Columns: itemName, location, lotNumber, quantity, expiry.
 * Chemical items require lot number (EU 178/2002) and expiry tracking (HACCP).
 */
import React from 'react';
import { StorageItemType } from '../../../hooks/useStorageInventory';
import { GenericStockTab } from './GenericStockTab';

export const ChemicalsStockTab: React.FC = () => (
  <GenericStockTab
    itemType={StorageItemType.CHEMICAL}
    itemLabel="chemicals"
    columns={['itemName', 'location', 'lotNumber', 'quantity', 'expiry']}
  />
);

export default ChemicalsStockTab;
