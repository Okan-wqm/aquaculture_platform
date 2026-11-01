import {
  runInTenantRead,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
} from '@aquaculture/backend-common/database';
import type { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { SENSOR_PLACEMENT_ERROR } from '@aquaculture/shared-contracts';
import { collaborator } from '@aquaculture/testing';
import { HttpException, NotFoundException } from '@nestjs/common';
import type { NatsRequestReply } from '@platform/event-bus';
import type { OutboxPublisher } from '@platform/outbox';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../../__tests__/support/sensor-rls-postgres.harness';
import { SensorDataChannel } from '../../../database/entities/sensor-data-channel.entity';
import { SensorProtocol } from '../../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../../database/entities/sensor.entity';
import { AuditLog } from '../../../infrastructure/audit/audit-log.entity';
import { SensorPlacementService } from '../sensor-placement.service';

/**
 * A sensor's move on real Postgres under FORCE RLS with a non-owner runtime
 * role (SENSOR-MEDIUM-206): the one UPDATE moves a parent with its children,
 * stamps placed_at and ends the legacy farm and pond; another tenant's row is
 * not found; and — the reason the placement columns are `update: false` — a
 * copy of the row loaded before the move, saved after it, cannot put the
 * sensor back where it was.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLD_SITE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const SITE = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const DEPARTMENT = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const SYSTEM = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const TANK = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const OPERATOR = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const ENTITIES = [Sensor, SensorDataChannel, SensorProtocol, SensorTypeDefinition];

jest.setTimeout(180_000);

describe('SensorPlacementService.relocate under FORCE RLS', () => {
  let stage: SensorRlsHarness | undefined;
  let service: SensorPlacementService;
  const ids: Record<string, string> = {};
  const enqueue = jest.fn().mockResolvedValue(undefined);
  // Untyped so it stands in for the generic execute<T>; the body runs fn().
  const execute = jest.fn();
  execute.mockImplementation(({ fn }: { fn: () => Promise<unknown> }) => fn());

  beforeAll(async () => {
    stage = await bootSensorRlsHarness({
      name: 'sensor_placement',
      tenants: [TENANT_A],
      entities: ENTITIES,
      sourceEntities: [AuditLog],
      beforeRls: async ({ admin, schema }) => {
        const insert = async (
          name: string,
          tenantId: string,
          extra: { parent?: string; isParent?: boolean } = {},
        ): Promise<void> => {
          const [row] = await admin.query(
            `INSERT INTO "${schema}".sensors
                 (tenant_id, name, serial_number, type, status, is_active, site_id, pond_id,
                  farm_id, is_parent_device, parent_id)
               VALUES ($1, $2, $2, 'multi_parameter', 'active', true, $3, 'old-pond', 'old-farm',
                       $4, $5)
             RETURNING id`,
            [tenantId, name, OLD_SITE, extra.isParent ?? false, extra.parent ?? null],
          );
          ids[name] = row.id;
        };
        await insert('parent', TENANT_A, { isParent: true });
        await insert('child', TENANT_A, { parent: ids['parent'] });
        await insert('standalone', TENANT_A);
        // Another tenant's row inside this tenant's schema: only RLS hides it.
        await insert('intruder', TENANT_B);
      },
    });
    service = new SensorPlacementService(
      stage.runtime,
      collaborator<NatsRequestReply>(
        { requestTyped: jest.fn().mockResolvedValue({ placeable: true, unitKind: 'TANK' }) },
        'NatsRequestReply',
      ),
      collaborator<CircuitBreakerService>({ execute }, 'CircuitBreakerService'),
      collaborator<OutboxPublisher>({ enqueue }, 'OutboxPublisher'),
    );
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  const place = { siteId: SITE, departmentId: DEPARTMENT, systemId: SYSTEM, unitId: TANK };

  async function stored(name: string): Promise<Record<string, unknown>> {
    const [row] = await stage!.admin.query(
      `SELECT site_id, department_id, system_id, tank_id, equipment_id, farm_id, pond_id,
              placed_at, name
         FROM "${stage!.schemaOf(TENANT_A)}".sensors WHERE id = $1`,
      [ids[name]],
    );
    return row;
  }

  it('moves a parent with its child, stamps placed_at and ends the legacy farm and pond', async () => {
    const before = Date.now();
    const moved = await service.relocate(TENANT_A, ids['parent']!, place, OPERATOR);
    expect(moved).toMatchObject({ siteId: SITE, tankId: TANK, systemId: SYSTEM });
    for (const name of ['parent', 'child']) {
      const row = await stored(name);
      expect(row).toMatchObject({
        site_id: SITE,
        department_id: DEPARTMENT,
        system_id: SYSTEM,
        tank_id: TANK,
        equipment_id: null,
        farm_id: null,
        pond_id: null,
      });
      expect((row['placed_at'] as Date).getTime()).toBeGreaterThanOrEqual(before - 1_000);
    }
    expect(enqueue).toHaveBeenCalledTimes(2);

    // The SQL UPDATE passes no entity subscriber: the move writes its own
    // audit row — from where to where, and who moved it.
    const audit: Array<Record<string, unknown>> = await stage!.admin.query(
      `SELECT entity_type, action, previous_value, new_value, changed_fields, changed_by
         FROM sensor.sensor_audit_logs WHERE entity_id = $1`,
      [ids['parent']],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity_type: 'Sensor',
      action: 'UPDATE',
      changed_by: OPERATOR,
      previous_value: expect.objectContaining({ siteId: OLD_SITE, pondId: 'old-pond' }),
      new_value: expect.objectContaining({ siteId: SITE, tankId: TANK, pondId: null }),
    });
  });

  it('refuses to move a child alone', async () => {
    const refused = await service
      .relocate(TENANT_A, ids['child']!, place, OPERATOR)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getResponse()).toMatchObject({
      code: SENSOR_PLACEMENT_ERROR.FOLLOWS_PARENT,
    });
  });

  it('does not find another tenant’s sensor, even inside this tenant’s schema', async () => {
    await expect(
      service.relocate(TENANT_A, ids['intruder']!, place, OPERATOR),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await stored('intruder')).toMatchObject({ site_id: OLD_SITE });
  });

  it('keeps the move when a copy loaded before it is saved after it (update: false)', async () => {
    const stale = await runInTenantRead(stage!.runtime, SENSOR_SOURCE_SCHEMA, TENANT_A, (qr) =>
      qr.manager.findOneOrFail(Sensor, { where: { id: ids['standalone']!, tenantId: TENANT_A } }),
    );
    await service.relocate(TENANT_A, ids['standalone']!, place, OPERATOR);

    stale.name = 'renamed after the move';
    await runInTenantTransaction(stage!.runtime, SENSOR_SOURCE_SCHEMA, TENANT_A, (qr) =>
      qr.manager.save(Sensor, stale),
    );

    expect(await stored('standalone')).toMatchObject({
      name: 'renamed after the move',
      site_id: SITE,
      tank_id: TANK,
      pond_id: null,
    });
  });
});
