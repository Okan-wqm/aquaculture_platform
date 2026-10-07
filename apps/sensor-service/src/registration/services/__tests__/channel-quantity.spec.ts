import { BadRequestException, NotFoundException } from '@nestjs/common';
import { stub } from '@aquaculture/testing';
import type { DataSource, Repository } from 'typeorm';

import { SensorDataChannel } from '../../../database/entities/sensor-data-channel.entity';
import { ChannelManagementService } from '../channel-management.service';
import { channelQuantity, declarationConflict } from '../channel-quantity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';

function channelRow(overrides: Partial<SensorDataChannel>): SensorDataChannel {
  return Object.assign(new SensorDataChannel(), {
    id: CHANNEL,
    tenantId: TENANT,
    channelKey: 'ammonia',
    unit: 'mg/L',
    declaredQuantity: null,
    ...overrides,
  });
}

describe('channel quantity', () => {
  describe('channelQuantity', () => {
    it('reads the key when nothing is declared', () => {
      expect(channelQuantity('ph', null)).toEqual({ quantity: 'ph', family: null });
    });

    it('leaves a family key unknown until its member is declared', () => {
      expect(channelQuantity('ammonia', null)).toEqual({ quantity: null, family: 'ammonia' });
      expect(channelQuantity('nh3', 'tan')).toEqual({ quantity: 'tan', family: 'ammonia' });
    });

    it('reads a stored value that is not a quantity id as no declaration', () => {
      expect(channelQuantity('ammonia', 'TAN-N')).toEqual({ quantity: null, family: 'ammonia' });
    });
  });

  describe('declarationConflict', () => {
    it('accepts a family member in its unit', () => {
      expect(declarationConflict('ammonia', 'tan', 'mg/L')).toBeNull();
      expect(declarationConflict('probe_7_ch2', 'h2s', 'µg/L')).toBeNull();
    });

    it('refuses an unknown id, a contradiction, and a unit of another magnitude', () => {
      expect(declarationConflict('ammonia', 'ammonium', 'mg/L')).toMatch(/not a measured quantity/);
      expect(declarationConflict('ph', 'temperature', null)).toMatch(/does not measure/);
      expect(declarationConflict('probe_7_ch2', 'h2s', 'mg/L')).toMatch(/not a unit of h2s/);
    });
  });

  describe('ChannelManagementService', () => {
    const findOne = jest.fn();
    const save = jest.fn();
    const service = new ChannelManagementService(
      stub<Repository<SensorDataChannel>>({ findOne, save }),
      stub<DataSource>({}),
    );

    beforeEach(() => {
      jest.clearAllMocks();
      save.mockImplementation((row: SensorDataChannel) => Promise.resolve(row));
    });

    it('stores a declaration that fits the channel', async () => {
      findOne.mockResolvedValue(channelRow({}));
      const saved = await service.declareQuantity(CHANNEL, TENANT, 'nh3');
      expect(saved.declaredQuantity).toBe('nh3');
      expect(findOne).toHaveBeenCalledWith({ where: { id: CHANNEL, tenantId: TENANT } });
    });

    it('declares an alternate and its unit in one write', async () => {
      findOne.mockResolvedValue(channelRow({ channelKey: 'do', unit: 'mg/L' }));
      await expect(
        service.declareQuantity(CHANNEL, TENANT, 'oxygenSaturation'),
      ).rejects.toBeInstanceOf(BadRequestException);
      findOne.mockResolvedValue(channelRow({ channelKey: 'do', unit: 'mg/L' }));
      const saved = await service.declareQuantity(CHANNEL, TENANT, 'oxygenSaturation', '%');
      expect({ quantity: saved.declaredQuantity, unit: saved.unit }).toEqual({
        quantity: 'oxygenSaturation',
        unit: '%',
      });
    });

    it('clears a declaration with null', async () => {
      findOne.mockResolvedValue(channelRow({ declaredQuantity: 'tan' }));
      expect((await service.declareQuantity(CHANNEL, TENANT, null)).declaredQuantity).toBeNull();
    });

    it('refuses a declaration that does not fit, without writing', async () => {
      findOne.mockResolvedValue(channelRow({ channelKey: 'ph', unit: 'pH' }));
      await expect(service.declareQuantity(CHANNEL, TENANT, 'tan')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(save).not.toHaveBeenCalled();
    });

    it('refuses another tenant’s channel as not found', async () => {
      findOne.mockResolvedValue(null);
      await expect(service.declareQuantity(CHANNEL, TENANT, 'tan')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('keeps a declared channel’s unit a unit of its quantity', async () => {
      findOne.mockResolvedValue(channelRow({ declaredQuantity: 'tan' }));
      await expect(service.updateChannel(CHANNEL, TENANT, { unit: 'NTU' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      findOne.mockResolvedValue(channelRow({ declaredQuantity: 'tan' }));
      expect((await service.updateChannel(CHANNEL, TENANT, { unit: 'ppm' })).unit).toBe('ppm');
    });

    it('leaves unit edits on an undeclared channel as they were', async () => {
      findOne.mockResolvedValue(channelRow({ channelKey: 'temperature', unit: '°C' }));
      expect((await service.updateChannel(CHANNEL, TENANT, { unit: '°F' })).unit).toBe('°F');
    });
  });
});
