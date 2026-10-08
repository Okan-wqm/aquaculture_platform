import { stub } from '@aquaculture/testing';

import type { DataChannelType } from '../dto/data-channel.dto';
import { ChannelResolver } from '../resolvers/channel.resolver';
import type { ChannelDiscoveryService } from '../services/channel-discovery.service';
import type { ChannelManagementService } from '../services/channel-management.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';

/** The quantity surface of a channel on GraphQL: what the picker reads and writes. */
describe('ChannelResolver — channel quantity', () => {
  const declareQuantity = jest.fn().mockResolvedValue({});
  const clearQuantity = jest.fn().mockResolvedValue({});
  const resolver = new ChannelResolver(
    stub<ChannelDiscoveryService>({}),
    stub<ChannelManagementService>({ declareQuantity, clearQuantity }),
  );
  const channel = (
    channelKey: string,
    declaredQuantity: DataChannelType['declaredQuantity'],
  ): DataChannelType => ({ channelKey, declaredQuantity }) as DataChannelType;

  it('declares with the caller as actor, passing quantity and unit through', async () => {
    await resolver.declareChannelQuantity(
      { channelId: CHANNEL, quantity: 'tan', unit: 'ppm' },
      TENANT,
      'user-7',
    );
    expect(declareQuantity).toHaveBeenCalledWith(CHANNEL, TENANT, 'user-7', 'tan', 'ppm');
  });

  it('clears only through its own mutation', async () => {
    await resolver.clearChannelQuantity(CHANNEL, TENANT, 'user-7');
    expect(clearQuantity).toHaveBeenCalledWith(CHANNEL, TENANT, 'user-7');
  });

  it('resolves the effective quantity, the family and the declarable choices', () => {
    expect(resolver.quantity(channel('ammonia', null))).toBeNull();
    expect(resolver.quantity(channel('ammonia', 'tan'))).toBe('tan');
    expect(resolver.quantity(channel('ph', null))).toBe('ph');
    expect(resolver.quantityFamily(channel('nh3', null))).toBe('ammonia');
    expect(resolver.quantityFamily(channel('ph', null))).toBeNull();
    expect(resolver.declarableQuantities(channel('ec', null))).toEqual([
      'conductivity',
      'specificConductance',
    ]);
  });
});
