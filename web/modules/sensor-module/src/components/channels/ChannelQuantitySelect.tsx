/**
 * What a channel measures, declared where its key does not say (a family key
 * such as `ammonia`) or says something other than the device reports. The
 * water-chemistry binding refuses a channel with no quantity or another one
 * than its parameter records (CHANNEL_HAS_NO_QUANTITY, QUANTITY_MISMATCH):
 * this select is where that is fixed. Each declaration is kept in the
 * channel's history by the sensor service.
 */
import { quantityLabel } from '@aquaculture/shared-ui';
import React from 'react';

import type { SensorDataChannel } from '../../hooks/useChannelManagement';

/** The option that clears a declaration, so the key's own meaning stands. */
const KEY_MEANING = '';

export const ChannelQuantitySelect: React.FC<{
  channel: Pick<
    SensorDataChannel,
    'channelKey' | 'quantity' | 'declaredQuantity' | 'quantityFamily' | 'declarableQuantities'
  >;
  disabled: boolean;
  onChange: (quantity: string | null) => void;
}> = ({ channel, disabled, onChange }) => {
  if (channel.declarableQuantities.length === 0) {
    return (
      <span className="text-xs text-gray-600 dark:text-gray-400">
        {channel.quantity === null ? 'Bilinmiyor' : quantityLabel(channel.quantity)}
      </span>
    );
  }
  return (
    <select
      aria-label={`${channel.channelKey} ölçülen büyüklük`}
      className="max-w-[16rem] rounded border border-gray-300 px-1 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800"
      value={channel.declaredQuantity ?? KEY_MEANING}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === KEY_MEANING ? null : event.target.value)}
    >
      <option value={KEY_MEANING}>
        {channel.quantityFamily === null
          ? `Anahtarın söylediği (${channel.quantity === null ? '—' : channel.quantity})`
          : `Bildirilmedi (${channel.quantityFamily} ailesi)`}
      </option>
      {channel.declarableQuantities.map((quantity) => (
        <option key={quantity} value={quantity}>
          {quantityLabel(quantity)}
        </option>
      ))}
    </select>
  );
};
