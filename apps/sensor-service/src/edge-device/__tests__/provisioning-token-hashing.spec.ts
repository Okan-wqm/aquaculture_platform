/**
 * SENSOR-MEDIUM-001 — provisioning secrets are hashed at rest.
 *
 * Both the per-device provisioning token and the tenant provisioning key must
 * be stored as their SHA-256 digest, never the plaintext. The plaintext is
 * surfaced to the caller exactly once (at creation) and every later lookup /
 * validation works against the digest. A database leak of these columns must be
 * non-replayable.
 */
import * as crypto from 'crypto';

import { NotFoundException } from '@nestjs/common';
import { collaborator, stub, stubMember } from '@aquaculture/testing';
import type { DataSource, Repository } from 'typeorm';

import { ProvisioningService } from '../provisioning.service';

// Rows and their directory routes commit in one tenant transaction, and keys
// resolve route → tenant boundary; the boundaries themselves are proven on real
// Postgres (edge-mqtt-auth.rls.postgres.spec). Here they pass straight through.
const mockTxManager = { insert: jest.fn() };
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: jest.fn(
    (_ds: unknown, _schema: string, _tenantId: string, fn: (qr: { manager: object }) => unknown) =>
      fn({ manager: mockTxManager }),
  ),
  runInSourceRead: jest.fn(),
  runInTenantRead: jest.fn(),
  tenantManagerRepo: jest.fn(),
}));
import {
  runInSourceRead,
  runInTenantRead,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';

import type { CreateTenantKeyInput } from '../dto/provisioning.dto';
import { TenantProvisioningKeyDirectory } from '../entities/tenant-provisioning-key-directory.entity';
import { InstallerScriptService } from '../installer-script.service';
import { TenantProvisioningKey } from '../entities/tenant-provisioning-key.entity';
import { provisioningKeyRouteHash, TenantKeyService } from '../tenant-key.service';
import { DeviceModel } from '../entities/edge-device.entity';

const sha256Hex = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');

describe('Provisioning secrets at-rest hashing (SENSOR-MEDIUM-001)', () => {
  describe('ProvisioningService.createProvisionedDevice', () => {
    it('stores sha256(token) and returns the plaintext exactly once', async () => {
      const deviceRepository = {
        create: jest.fn((dto: Record<string, unknown>) => dto),
      };
      const installerScriptService = {
        buildInstallerUrl: jest.fn(async () => 'https://host/install/DEV-1'),
        buildInstallerCommand: jest.fn(async () => 'curl ... | sudo bash'),
      };
      const configService = { get: jest.fn((_k: string, fallback?: unknown) => fallback) };

      const deviceDirectory = {
        saveNewDevice: jest.fn(async (dto: Record<string, unknown>) => ({
          id: 'device-1',
          ...dto,
        })),
      };
      const service = new ProvisioningService(
        deviceRepository as never,
        stub<DataSource>({}), // consumed only by the mocked runInTenantTransaction
        configService as never,
        {} as never, // mqttAuthService
        installerScriptService as never,
        {} as never, // tenantKeyService
        {} as never, // deviceEventService
        deviceDirectory as never,
      );

      const response = await service.createProvisionedDevice(
        'tenant-1',
        { deviceName: 'Probe', deviceModel: DeviceModel.CUSTOM } as never,
        'user-1',
      );

      // The response carries the raw 64-hex plaintext token.
      expect(response.provisioningToken).toMatch(/^[a-f0-9]{64}$/);

      // What was persisted is the digest, NOT the plaintext.
      expect(deviceRepository.create).toHaveBeenCalledTimes(1);
      const persisted = deviceRepository.create.mock.calls[0]![0] as { provisioningToken: string };
      expect(persisted.provisioningToken).toBe(sha256Hex(response.provisioningToken));
      expect(persisted.provisioningToken).not.toBe(response.provisioningToken);
    });
  });

  describe('TenantKeyService', () => {
    it('createTenantKey persists sha256(key) and its route in the same transaction', async () => {
      mockTxManager.insert.mockClear();
      const create = jest.fn((dto: Partial<TenantProvisioningKey>) =>
        Object.assign(new TenantProvisioningKey(), dto),
      );
      (tenantManagerRepo as jest.Mock).mockReturnValue({
        save: jest.fn(async (dto: Record<string, unknown>) => ({ id: 'key-1', ...dto })),
      });
      const installerScriptService = collaborator<InstallerScriptService>(
        {
          buildTenantInstallerUrl: jest.fn(async () => 'https://host/install/tenant'),
          buildTenantInstallerCommand: jest.fn(async () => 'curl tenant | sudo bash'),
        },
        'InstallerScriptService',
      );

      const service = new TenantKeyService(
        collaborator<Repository<TenantProvisioningKey>>(
          { create: stubMember<Repository<TenantProvisioningKey>['create']>(create) },
          'TenantProvisioningKeyRepository',
        ),
        installerScriptService,
        stub<DataSource>({}),
      );

      const response = await service.createTenantKey(
        'tenant-1',
        stub<CreateTenantKeyInput>({ name: 'Fleet key' }),
        'user-1',
      );

      expect(response.keyToken).toMatch(/^[a-f0-9]{64}$/);
      expect(create).toHaveBeenCalledTimes(1);
      const persisted = create.mock.calls[0]![0];
      expect(persisted.keyToken).toBe(sha256Hex(response.keyToken));
      expect(persisted.keyToken).not.toBe(response.keyToken);

      // SENSOR-HIGH-175: the route is a hash of the digest, never the digest.
      const routeHash = provisioningKeyRouteHash(sha256Hex(response.keyToken));
      expect(mockTxManager.insert).toHaveBeenCalledWith(TenantProvisioningKeyDirectory, {
        routeHash,
        keyId: 'key-1',
        tenantId: 'tenant-1',
      });
      expect(routeHash).not.toBe(persisted.keyToken);
    });

    it('validateAndGetKey routes by hash, reads the key in that tenant, and rejects a miss', async () => {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const digest = sha256Hex(rawToken);
      const key = Object.assign(new TenantProvisioningKey(), {
        id: 'key-1',
        tenantId: 'tenant-1',
        keyToken: digest,
        isActive: true,
        usedCount: 0,
      });
      const routeQuery = jest.fn(async (_sql: string, params: unknown[]) =>
        params[0] === provisioningKeyRouteHash(digest) ? [{ tenant_id: 'tenant-1' }] : [],
      );
      (runInSourceRead as jest.Mock).mockImplementation((_ds, _schema, fn) =>
        fn({ query: routeQuery }),
      );
      (runInTenantRead as jest.Mock).mockImplementation((_ds, _schema, _tenant, fn) =>
        fn({ manager: {} }),
      );
      (tenantManagerRepo as jest.Mock).mockReturnValue({
        findOne: jest.fn(async (options: { where: { keyToken: string } }) =>
          options.where.keyToken === digest ? key : null,
        ),
      });

      const service = new TenantKeyService(
        collaborator<Repository<TenantProvisioningKey>>({}, 'TenantProvisioningKeyRepository'),
        collaborator<InstallerScriptService>({}, 'InstallerScriptService'),
        stub<DataSource>({}),
      );

      await expect(service.validateAndGetKey(rawToken)).resolves.toBe(key);
      expect((runInTenantRead as jest.Mock).mock.calls[0]?.[2]).toBe('tenant-1');

      (runInTenantRead as jest.Mock).mockClear();
      await expect(service.validateAndGetKey('deadbeef'.repeat(8))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // A route miss never opens a tenant boundary.
      expect(runInTenantRead).not.toHaveBeenCalled();
    });
  });
});
