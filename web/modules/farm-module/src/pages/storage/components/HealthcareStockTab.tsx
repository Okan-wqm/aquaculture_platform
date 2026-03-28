/**
 * Healthcare Stock Tab - Thin wrapper around GenericStockTab for healthcare product inventory.
 *
 * Columns: itemName, location, lotNumber, quantity, expiry.
 * Healthcare products (antibiotics, vaccines, supplements) require expiry tracking (HACCP).
 */
import React from 'react';
import { StorageItemType } from '../../../hooks/useStorageInventory';
import { GenericStockTab } from './GenericStockTab';

export const HealthcareStockTab: React.FC = () => (
  <GenericStockTab
    itemType={StorageItemType.HEALTHCARE}
    itemLabel="healthcare products"
    columns={['itemName', 'location', 'lotNumber', 'quantity', 'expiry']}
  />
);

export default HealthcareStockTab;
