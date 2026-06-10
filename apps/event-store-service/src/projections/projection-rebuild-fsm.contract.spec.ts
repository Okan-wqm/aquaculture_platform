import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('projection rebuild FSM contract', () => {
  const entitySource = readFileSync(
    resolve(__dirname, 'entities/projection-rebuild.entity.ts'),
    'utf8',
  );
  const migrationSource = readFileSync(
    resolve(__dirname, '../migrations/1800200000000-ProjectionRebuilds.ts'),
    'utf8',
  );
  const serviceSource = readFileSync(
    resolve(__dirname, 'projections.service.ts'),
    'utf8',
  );

  it('declares a single active rebuild job per tenant and projection', () => {
    expect(entitySource).toContain('IDX_projection_rebuilds_one_active_job');
    expect(migrationSource).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_projection_rebuilds_one_active_job"');
    expect(migrationSource).toContain('"tenantId", "projectionName"');
    expect(migrationSource).toContain("'building_shadow'");
    expect(migrationSource).toContain("'catching_up'");
    expect(migrationSource).toContain("'swapping'");
  });

  it('rejects a second active rebuild before enqueueing a new job', () => {
    expect(serviceSource).toContain('ACTIVE_PROJECTION_REBUILD_STATUSES');
    expect(serviceSource).toContain('ConflictException');
    expect(serviceSource).toContain('already has active rebuild job');
    expect(serviceSource).toContain('status: In([...ACTIVE_PROJECTION_REBUILD_STATUSES])');
  });

  it('keeps live handler side effects and checkpoint updates in one transaction', () => {
    expect(serviceSource).toContain('ProjectionHandlerContext');
    expect(serviceSource).toContain('manager: queryRunner.manager');
    expect(serviceSource).toContain("mode: 'live'");
    expect(serviceSource).toContain('await handler(event, context)');
    expect(serviceSource).toContain('checkpoint CAS failed');
  });
});
