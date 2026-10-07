import { BadRequestException, NotFoundException } from '@nestjs/common';
import { stub } from '@aquaculture/testing';
import type { DataSource, Repository } from 'typeorm';

import {
  ChannelQuantityDeclaration,
  QuantityDeclarationReason,
} from '../../../database/entities/channel-quantity-declaration.entity';
import {
  ChannelDataType,
  SensorDataChannel,
} from '../../../database/entities/sensor-data-channel.entity';
import { ChannelManagementService } from '../channel-management.service';
import { channelQuantity, declarationConflict, declaredUnit } from '../channel-quantity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const SENSOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = 'user-7';

function channelRow(overrides: Partial<SensorDataChannel>): SensorDataChannel {
  return Object.assign(new SensorDataChannel(), {
    id: CHANNEL,
    tenantId: TENANT,
    sensorId: SENSOR,
    channelKey: 'ammonia',
    unit: 'mg/L',
    dataType: ChannelDataType.NUMBER,
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
  });

  describe('declarationConflict', () => {
    it('accepts a family member in its unit or a unit it converts from', () => {
      expect(declarationConflict('ammonia', 'tan', 'mg/L')).toBeNull();
      expect(declarationConflict('probe_7_ch2', 'h2s', 'mg/L')).toBeNull();
      expect(declarationConflict('ec', 'specificConductance', 'mS/cm')).toBeNull();
    });

    it('refuses an unknown id, a quantity the key does not allow, and a unit of something else', () => {
      expect(declarationConflict('ammonia', 'ammonium', 'mg/L')).toMatch(/not a measured quantity/);
      expect(declarationConflict('ph', 'temperature', '°C')).toMatch(/cannot be declared/);
      expect(declarationConflict('do', 'oxygenSaturation', '%')).toMatch(/cannot be declared/);
      expect(declarationConflict('probe_7_ch2', 'h2s', 'NTU')).toMatch(/not a unit of h2s/);
      expect(declarationConflict('probe_7_ch2', 'h2s', '')).toMatch(/not a unit of h2s/);
    });
  });

  it('gives a declared channel a unit: the given one, else its own, else the canonical', () => {
    expect(declaredUnit('tan', 'ppm', 'mg/L')).toBe('ppm');
    expect(declaredUnit('tan', undefined, 'mg/l')).toBe('mg/l');
    expect(declaredUnit('h2s', undefined, null)).toBe('µg/L');
  });

  describe('ChannelManagementService', () => {
    const findOne = jest.fn();
    const managerSave = jest.fn();
    const managerCreate = jest.fn();
    const manager = { findOne, save: managerSave, create: managerCreate };
    const transaction = jest.fn();
    const repoFind = jest.fn();
    const repoDelete = jest.fn();
    const repoSave = jest.fn();
    const repoCreate = jest.fn();
    const service = new ChannelManagementService(
      stub<Repository<SensorDataChannel>>({
        find: repoFind,
        delete: repoDelete,
        save: repoSave,
        create: repoCreate,
      }),
      stub<DataSource>({ transaction }),
    );

    const ledgerRows = (): Array<Partial<ChannelQuantityDeclaration>> =>
      managerCreate.mock.calls
        .filter(([entity]) => entity === ChannelQuantityDeclaration)
        .map(([, row]) => row as Partial<ChannelQuantityDeclaration>);

    beforeEach(() => {
      jest.clearAllMocks();
      transaction.mockImplementation((work: (m: typeof manager) => Promise<unknown>) =>
        work(manager),
      );
      managerSave.mockImplementation((_entity: unknown, row: unknown) => Promise.resolve(row));
      managerCreate.mockImplementation((_entity: unknown, row: unknown) => row);
      repoCreate.mockImplementation((row: Partial<SensorDataChannel>) =>
        Object.assign(new SensorDataChannel(), row),
      );
      repoSave.mockImplementation((rows: SensorDataChannel[]) =>
        Promise.resolve(rows.map((row, index) => Object.assign(row, { id: `new-${index}` }))),
      );
    });

    it('reads the channel under the row lock, tenant-scoped', async () => {
      findOne.mockResolvedValue(channelRow({}));
      await service.declareQuantity(CHANNEL, TENANT, ACTOR, 'nh3');
      expect(findOne).toHaveBeenCalledWith(SensorDataChannel, {
        where: { id: CHANNEL, tenantId: TENANT },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('stores a declaration that fits, with a ledger row naming the actor', async () => {
      findOne.mockResolvedValue(channelRow({}));
      const saved = await service.declareQuantity(CHANNEL, TENANT, ACTOR, 'nh3');
      expect(saved.declaredQuantity).toBe('nh3');
      expect(ledgerRows()).toEqual([
        expect.objectContaining({
          channelId: CHANNEL,
          sensorId: SENSOR,
          channelKey: 'ammonia',
          quantity: 'nh3',
          unit: 'mg/L',
          reason: QuantityDeclarationReason.DECLARED,
          declaredBy: ACTOR,
        }),
      ]);
    });

    it('declares a convertible unit in the same write, and gives a unitless channel the canonical one', async () => {
      findOne.mockResolvedValue(channelRow({ channelKey: 'ec', unit: 'µS/cm' }));
      const ec = await service.declareQuantity(
        CHANNEL,
        TENANT,
        ACTOR,
        'specificConductance',
        'mS/cm',
      );
      expect({ quantity: ec.declaredQuantity, unit: ec.unit }).toEqual({
        quantity: 'specificConductance',
        unit: 'mS/cm',
      });
      findOne.mockResolvedValue(channelRow({ channelKey: 'probe_7_ch2', unit: undefined }));
      expect((await service.declareQuantity(CHANNEL, TENANT, ACTOR, 'h2s')).unit).toBe('µg/L');
    });

    it('refuses a declaration that does not fit, writing nothing', async () => {
      findOne.mockResolvedValue(channelRow({ channelKey: 'ph', unit: 'pH' }));
      await expect(service.declareQuantity(CHANNEL, TENANT, ACTOR, 'tan')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        service.declareQuantity(CHANNEL, TENANT, ACTOR, 'not-a-quantity'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(managerSave).not.toHaveBeenCalled();
    });

    it('answers another tenant’s channel as not found', async () => {
      findOne.mockResolvedValue(null);
      await expect(service.declareQuantity(CHANNEL, TENANT, ACTOR, 'tan')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('clears a declaration on record, and leaves an undeclared channel untouched', async () => {
      findOne.mockResolvedValue(channelRow({ declaredQuantity: 'tan' }));
      expect((await service.clearQuantity(CHANNEL, TENANT, ACTOR)).declaredQuantity).toBeNull();
      expect(ledgerRows()).toEqual([
        expect.objectContaining({ quantity: null, reason: QuantityDeclarationReason.CLEARED }),
      ]);
      jest.clearAllMocks();
      findOne.mockResolvedValue(channelRow({}));
      await service.clearQuantity(CHANNEL, TENANT, ACTOR);
      expect(managerSave).not.toHaveBeenCalled();
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

    describe('rediscovery that replaces channels', () => {
      const rediscover = (unit: string): Promise<SensorDataChannel[]> => {
        repoFind.mockResolvedValue([channelRow({ declaredQuantity: 'tan' })]);
        return service.saveDiscoveredChannels(
          SENSOR,
          TENANT,
          [
            {
              channelKey: 'ammonia',
              suggestedLabel: 'Ammonia',
              inferredDataType: ChannelDataType.NUMBER,
              inferredUnit: unit,
              sampleValue: 0.4,
              dataPath: 'ammonia',
            },
          ],
          true,
        );
      };

      it('carries the key’s declaration to the re-created channel', async () => {
        const [channel] = await rediscover('mg/L');
        expect(channel?.declaredQuantity).toBe('tan');
        expect(ledgerRows()).toEqual([]);
      });

      it('ends it on record when the rediscovered unit no longer fits', async () => {
        const [channel] = await rediscover('NTU');
        expect(channel?.declaredQuantity).toBeNull();
        expect(ledgerRows()).toEqual([
          expect.objectContaining({
            channelKey: 'ammonia',
            quantity: null,
            reason: QuantityDeclarationReason.REDISCOVERY_CLEARED,
            declaredBy: 'system:rediscovery',
          }),
        ]);
      });
    });
  });
});
