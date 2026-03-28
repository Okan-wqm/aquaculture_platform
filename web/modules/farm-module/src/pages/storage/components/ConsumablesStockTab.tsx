/**
 * Consumables Stock Tab - Thin wrapper around GenericStockTab for consumable inventory.
 *
 * Columns: itemName, location, lotNumber, quantity, notes.
 * Consumables typically do not expire, so the notes column replaces expiry.
 */
import React from 'react';
import { StorageItemType } from '../../../hooks/useStorageInventory';
import { GenericStockTab } from './GenericStockTab';

export const ConsumablesStockTab: React.FC = () => (
  <GenericStockTab
    itemType={StorageItemType.CONSUMABLE}
    itemLabel="consumables"
    columns={['itemName', 'location', 'lotNumber', 'quantity', 'notes']}
  />
);

export default ConsumablesStockTab;
