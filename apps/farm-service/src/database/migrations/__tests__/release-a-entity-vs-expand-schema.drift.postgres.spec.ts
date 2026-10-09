import { createSchemaDriftValidator } from '@aquaculture/backend-common/database';
import { stub, stubMember } from '@aquaculture/testing';
import type { ConfigService } from '@nestjs/config';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { randomBytes } from 'crypto';
import {
  Column,
  CreateDateColumn,
  DataSource,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { ExtendParamEquipmentToChannelSources1822000000000 } from '../1822000000000-ExtendParamEquipmentToChannelSources';

/**
 * Why Release A ships before the expand migration (plan D9, DATA-MEDIUM-020),
 * proven with the real schema-drift validator, fatal as in production.
 *
 * The farm source schema is migrated to the expand shape (Release B DDL).
 * The release then serving must still boot:
 *
 * - Release A's entity (57076d8a3: equipmentId, monitoringFrequency and
 *   alertEnabled nullable) validates clean against it;
 * - the release before A (those columns NOT NULL) is refused — the restart
 *   that would hit a pod running it between the migration and the rollout.
 *
 * The two entities are the frozen shapes of those releases, as deployed; they
 * are fixtures of history, not a second owner of the live entity.
 */
const MONITORING = ['continuous', 'hourly', 'daily', 'weekly', 'on_demand'] as const;

@Entity('water_quality_param_equipment')
class ReleaseAParamEquipment {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('uuid') tenantId!: string;
  @Column('uuid') parameterConfigId!: string;
  @Column({ type: 'uuid', nullable: true }) equipmentId!: string | null;
  @Column({ default: true }) isActive!: boolean;
  @Column({ type: 'enum', enum: MONITORING, default: 'on_demand', nullable: true })
  monitoringFrequency!: string | null;
  @Column({ type: 'uuid', nullable: true }) sensorId!: string | null;
  @Column({ type: 'boolean', default: true, nullable: true }) alertEnabled!: boolean | null;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('water_quality_param_equipment')
class PreReleaseAParamEquipment {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('uuid') tenantId!: string;
  @Column('uuid') parameterConfigId!: string;
  @Column('uuid') equipmentId!: string;
  @Column({ default: true }) isActive!: boolean;
  @Column({ type: 'enum', enum: MONITORING, default: 'on_demand' }) monitoringFrequency!: string;
  @Column({ type: 'uuid', nullable: true }) sensorId!: string | null;
  @Column({ default: true }) alertEnabled!: boolean;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

jest.setTimeout(180_000);

describe('Release A entity against the Release B schema (real drift validator)', () => {
  let harness: HarnessContext | undefined;

  const settings: Readonly<Record<string, string>> = {
    NODE_ENV: 'production',
    SCHEMA_DRIFT_ENABLED: 'true',
  };
  const productionConfig = stub<ConfigService>({
    get: stubMember<ConfigService['get']>(
      (key: string, fallback?: string): string | undefined => settings[key] ?? fallback,
    ),
  });

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    const admin = harness.dataSource;
    await admin.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await admin.query(`CREATE SCHEMA farm`);
    await admin.query(`
      CREATE TYPE farm.water_quality_param_equipment_monitoringfrequency_enum
        AS ENUM ('continuous', 'hourly', 'daily', 'weekly', 'on_demand')`);
    await admin.query(`CREATE TABLE farm.tanks (id uuid PRIMARY KEY, "tenantId" uuid NOT NULL)`);
    await admin.query(`
      CREATE TABLE farm.equipment (
        id uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "isTank" boolean NOT NULL DEFAULT false)`);
    await admin.query(`
      CREATE TABLE farm.water_quality_param_equipment (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL,
        "parameterConfigId" uuid NOT NULL, "equipmentId" uuid NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "monitoringFrequency" farm.water_quality_param_equipment_monitoringfrequency_enum
          NOT NULL DEFAULT 'on_demand',
        "sensorId" uuid, "alertEnabled" boolean NOT NULL DEFAULT true, "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("id"))`);
    const runner = admin.createQueryRunner();
    try {
      await runner.query(`SET search_path TO farm, public`);
      await runner.startTransaction();
      await new ExtendParamEquipmentToChannelSources1822000000000().up(runner);
      await runner.commitTransaction();
    } finally {
      await runner.release();
    }
  });

  afterAll(async () => {
    if (harness) await shutdownHarness(harness);
  });

  async function bootValidator(entity: new () => object): Promise<void> {
    const dataSource = new DataSource({
      type: 'postgres',
      ...harness!.connectionOptions,
      name: `release-a-drift-${randomBytes(4).toString('hex')}`,
      entities: [entity],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    try {
      const Validator = createSchemaDriftValidator('farm');
      await new Validator(dataSource, productionConfig).onApplicationBootstrap();
    } finally {
      await dataSource.destroy();
    }
  }

  it('boots the Release A entity clean after the expand migration', async () => {
    await expect(bootValidator(ReleaseAParamEquipment)).resolves.toBeUndefined();
  });

  it('refuses to boot the release before A — why A ships first', async () => {
    await expect(bootValidator(PreReleaseAParamEquipment)).rejects.toThrow(
      /entity declares NOT NULL but DB column is nullable/,
    );
  });
});
