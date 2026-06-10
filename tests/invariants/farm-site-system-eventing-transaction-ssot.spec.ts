import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const migratedWriteHandlers = [
  'apps/farm-service/src/site/handlers/create-site.handler.ts',
  'apps/farm-service/src/site/handlers/update-site.handler.ts',
  'apps/farm-service/src/site/handlers/delete-site.handler.ts',
  'apps/farm-service/src/site/handlers/upsert-site-contacts.handler.ts',
  'apps/farm-service/src/department/handlers/create-department.handler.ts',
  'apps/farm-service/src/department/handlers/update-department.handler.ts',
  'apps/farm-service/src/department/handlers/delete-department.handler.ts',
  'apps/farm-service/src/system/handlers/create-system.handler.ts',
  'apps/farm-service/src/system/handlers/update-system.handler.ts',
  'apps/farm-service/src/system/handlers/delete-system.handler.ts',
  'apps/farm-service/src/supplier/handlers/set-supplier-approved-sites.handler.ts',
  'apps/farm-service/src/equipment/handlers/create-equipment.handler.ts',
  'apps/farm-service/src/equipment/handlers/update-equipment.handler.ts',
  'apps/farm-service/src/equipment/handlers/delete-equipment.handler.ts',
  'apps/farm-service/src/equipment/handlers/create-sub-equipment.handler.ts',
  'apps/farm-service/src/equipment/handlers/update-sub-equipment.handler.ts',
  'apps/farm-service/src/equipment/handlers/delete-sub-equipment.handler.ts',
  'apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts',
  'apps/farm-service/src/tank/handlers/create-tank.handler.ts',
  'apps/farm-service/src/tank/handlers/update-tank.handler.ts',
  'apps/farm-service/src/tank/handlers/update-tank-status.handler.ts',
  'apps/farm-service/src/tank/handlers/delete-tank.handler.ts',
];

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('INVARIANT: farm setup hierarchy writes use transaction and outbox SSOT', () => {
  it('keeps migrated write handlers on tenant transaction plus tenantManagerRepo', () => {
    for (const path of migratedWriteHandlers) {
      const source = read(path);
      expect(source).toMatch(/runInTenantTransaction\(this\.dataSource, 'farm', tenantId/);
      expect(source).toMatch(/tenantManagerRepo\(queryRunner\.manager,/);
      expect(source).toMatch(/private readonly dataSource: DataSource/);
      expect(source).not.toMatch(/@InjectRepository\(/);
      expect(source).not.toMatch(/private readonly \w+Repository: Repository/);
    }
  });

  it('keeps migrated write events durable and transaction-bound', () => {
    for (const path of migratedWriteHandlers) {
      const source = read(path);
      expect(source).toMatch(/OutboxPublisher/);
      expect(source).toMatch(/createBaseEvent/);
      expect(source).toMatch(/outboxPublisher\.enqueue\([\s\S]*queryRunner\.manager/);
      expect(source).not.toMatch(/eventBus\.publish\(/);
      expect(source).not.toMatch(/NatsEventBus/);
      expect(source).not.toMatch(/@Inject\('EVENT_BUS'\)/);
      expect(source).not.toMatch(/catch \(eventError\)/);
    }
  });
});
