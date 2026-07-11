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

import { ProvisioningService } from '../provisioning.service';
import { TenantKeyService } from '../tenant-key.service';
import { DeviceModel } from '../entities/edge-device.entity';

const sha256Hex = (v: string): string =>
  crypto.createHash('sha256').update(v).digest('hex');

describe('Provisioning secrets at-rest hashing (SENSOR-MEDIUM-001)', () => {
  describe('ProvisioningService.createProvisionedDevice', () => {
    it('stores sha256(token) and returns the plaintext exactly once', async () => {
      const deviceRepository = {
        create: jest.fn((dto: Record<string, unknown>) => dto),
        save: jest.fn(async (dto: Record<string, unknown>) => ({ id: 'device-1', ...dto })),
      };
      const installerScriptService = {
        buildInstallerUrl: jest.fn(async () => 'https://host/install/DEV-1'),
        buildInstallerCommand: jest.fn(async () => 'curl ... | sudo bash'),
      };
      const configService = { get: jest.fn((_k: string, fallback?: unknown) => fallback) };

      const deviceDirectory = { upsert: jest.fn().mockResolvedValue(undefined) };
      const service = new ProvisioningService(
        deviceRepository as never,
        {} as never, // dataSource — unused on this path
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
    const buildKeyRow = (keyTokenHash: string): Record<string, unknown> => ({
      id: 'key-1',
      tenant_id: 'tenant-1',
      key_token: keyTokenHash,
      name: 'Fleet key',
      is_active: true,
      max_devices: null,
      used_count: 0,
      auto_approve: false,
      default_site_id: null,
      expires_at: null,
      created_by: 'user-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    it('createTenantKey persists sha256(key) and returns the plaintext once', async () => {
      const tenantKeyRepository = {
        create: jest.fn((dto: Record<string, unknown>) => dto),
        save: jest.fn(async (dto: Record<string, unknown>) => ({ id: 'key-1', ...dto })),
      };
      const installerScriptService = {
        buildTenantInstallerUrl: jest.fn(async () => 'https://host/install/tenant'),
        buildTenantInstallerCommand: jest.fn(async () => 'curl tenant | sudo bash'),
      };

      const service = new TenantKeyService(
        tenantKeyRepository as never,
        installerScriptService as never,
        {} as never, // dataSource — unused on this path
      );

      const response = await service.createTenantKey(
        'tenant-1',
        { name: 'Fleet key' } as never,
        'user-1',
      );

      expect(response.keyToken).toMatch(/^[a-f0-9]{64}$/);
      expect(tenantKeyRepository.create).toHaveBeenCalledTimes(1);
      const persisted = tenantKeyRepository.create.mock.calls[0]![0] as { keyToken: string };
      expect(persisted.keyToken).toBe(sha256Hex(response.keyToken));
      expect(persisted.keyToken).not.toBe(response.keyToken);
    });

    it('validateAndGetKey resolves by digest and rejects a wrong token', async () => {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const storedRow = buildKeyRow(sha256Hex(rawToken));

      // dataSource.query: first call lists tenant schemas, second is the
      // UNION-ALL lookup keyed by the digest.
      const query = jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('information_schema.schemata')) {
          return [{ schema_name: 'tenant_0123456789abcdef' }];
        }
        return params?.[0] === sha256Hex(rawToken) ? [storedRow] : [];
      });

      const service = new TenantKeyService(
        {} as never,
        {} as never,
        { query } as never,
      );

      const key = await service.validateAndGetKey(rawToken);
      expect(key.id).toBe('key-1');
      expect(key.tenantId).toBe('tenant-1');

      await expect(service.validateAndGetKey('deadbeef'.repeat(8))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
