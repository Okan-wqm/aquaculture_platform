# Dynamic Sensor Channels + AI Auto-Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the sensor module industry-agnostic by replacing hardcoded sensor type ENUMs with dynamic type definitions, industry templates, and AI-assisted channel auto-detection.

**Architecture:** Template + Dynamic Channel approach. Three new DB tables (`sensor_type_definitions`, `industry_templates`, `channel_detection_log`). AI operates at configuration level via existing tool system — never modifies schema. Frontend renders dynamically from `sensor_data_channels` metadata.

**Tech Stack:** NestJS, TypeORM, TimescaleDB/PostgreSQL, GraphQL Federation v2 (code-first), Claude Anthropic SDK (existing ai-service tool system), React + Zustand + raw fetch GraphQL

---

## Task 1: Database Migration — New Tables

**Files:**
- Create: `apps/sensor-service/src/database/migrations/1740200000000-CreateDynamicSensorTypes.ts`

**Step 1: Write the migration file**

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDynamicSensorTypes1740200000000 implements MigrationInterface {
  name = 'CreateDynamicSensorTypes1740200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. sensor_type_definitions
    const typeDefsExists = await this.tableExists(queryRunner, 'sensor_type_definitions');
    if (!typeDefsExists) {
      console.log('Creating sensor_type_definitions table...');
      await queryRunner.query(`
        CREATE TABLE "sensor_type_definitions" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "type_key" VARCHAR(100) NOT NULL,
          "display_name" VARCHAR(200) NOT NULL,
          "description" TEXT,
          "icon" VARCHAR(100),
          "category" VARCHAR(100),
          "industry" VARCHAR(100),
          "is_system" BOOLEAN DEFAULT false,
          "default_channels" JSONB DEFAULT '[]',
          "metadata" JSONB DEFAULT '{}',
          "created_at" TIMESTAMPTZ DEFAULT now(),
          "updated_at" TIMESTAMPTZ DEFAULT now(),
          UNIQUE("tenant_id", "type_key")
        )
      `);
      await queryRunner.query(`CREATE INDEX "IDX_sensor_type_defs_tenant" ON "sensor_type_definitions" ("tenant_id")`);
      await queryRunner.query(`CREATE INDEX "IDX_sensor_type_defs_industry" ON "sensor_type_definitions" ("industry")`);
      await queryRunner.query(`CREATE INDEX "IDX_sensor_type_defs_category" ON "sensor_type_definitions" ("category")`);
    }

    // 2. industry_templates
    const templatesExists = await this.tableExists(queryRunner, 'industry_templates');
    if (!templatesExists) {
      console.log('Creating industry_templates table...');
      await queryRunner.query(`
        CREATE TABLE "industry_templates" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "template_key" VARCHAR(100) UNIQUE NOT NULL,
          "display_name" VARCHAR(200) NOT NULL,
          "description" TEXT,
          "icon" VARCHAR(100),
          "sensor_types" JSONB NOT NULL DEFAULT '[]',
          "dashboard_layout" JSONB,
          "alert_presets" JSONB,
          "is_active" BOOLEAN DEFAULT true,
          "created_at" TIMESTAMPTZ DEFAULT now()
        )
      `);
    }

    // 3. channel_detection_log
    const detectionLogExists = await this.tableExists(queryRunner, 'channel_detection_log');
    if (!detectionLogExists) {
      console.log('Creating channel_detection_log table...');
      await queryRunner.query(`
        CREATE TABLE "channel_detection_log" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "sensor_id" UUID NOT NULL REFERENCES "sensors"("id") ON DELETE CASCADE,
          "raw_sample" JSONB NOT NULL,
          "ai_analysis" JSONB NOT NULL,
          "proposed_channels" JSONB NOT NULL,
          "user_action" VARCHAR(20),
          "final_channels" JSONB,
          "created_at" TIMESTAMPTZ DEFAULT now()
        )
      `);
      await queryRunner.query(`CREATE INDEX "IDX_channel_detection_tenant" ON "channel_detection_log" ("tenant_id")`);
      await queryRunner.query(`CREATE INDEX "IDX_channel_detection_sensor" ON "channel_detection_log" ("sensor_id")`);
    }

    // 4. Add type_definition_id FK to sensors
    const hasColumn = await this.columnExists(queryRunner, 'sensors', 'type_definition_id');
    if (!hasColumn) {
      console.log('Adding type_definition_id to sensors table...');
      await queryRunner.query(`
        ALTER TABLE "sensors" ADD COLUMN "type_definition_id" UUID REFERENCES "sensor_type_definitions"("id") ON DELETE SET NULL
      `);
      await queryRunner.query(`CREATE INDEX "IDX_sensors_type_definition" ON "sensors" ("type_definition_id")`);
    }

    // 5. Seed aquaculture industry template
    console.log('Seeding aquaculture industry template...');
    await queryRunner.query(`
      INSERT INTO "industry_templates" ("template_key", "display_name", "description", "icon", "sensor_types", "alert_presets")
      VALUES (
        'aquaculture',
        'Aquaculture / Fish Farming',
        'Su ürünleri yetiştiriciliği için sensör yapılandırması. pH, sıcaklık, çözünmüş oksijen, tuzluluk ve daha fazlası.',
        'fish',
        '${JSON.stringify([
          { typeKey: 'temperature', displayName: 'Temperature Sensor', category: 'water_quality', defaultChannels: [{ channelKey: 'temperature', displayLabel: 'Temperature', unit: '°C', dataType: 'number', operationalMin: 0, operationalMax: 40, widgetType: 'gauge' }] },
          { typeKey: 'ph', displayName: 'pH Sensor', category: 'water_quality', defaultChannels: [{ channelKey: 'ph', displayLabel: 'pH', unit: 'pH', dataType: 'number', operationalMin: 0, operationalMax: 14, widgetType: 'gauge' }] },
          { typeKey: 'dissolved_oxygen', displayName: 'Dissolved Oxygen Sensor', category: 'water_quality', defaultChannels: [{ channelKey: 'dissolved_oxygen', displayLabel: 'Dissolved Oxygen', unit: 'mg/L', dataType: 'number', operationalMin: 0, operationalMax: 20, widgetType: 'gauge' }] },
          { typeKey: 'salinity', displayName: 'Salinity Sensor', category: 'water_quality', defaultChannels: [{ channelKey: 'salinity', displayLabel: 'Salinity', unit: 'ppt', dataType: 'number', operationalMin: 0, operationalMax: 40, widgetType: 'gauge' }] },
          { typeKey: 'ammonia', displayName: 'Ammonia Sensor', category: 'water_quality', defaultChannels: [{ channelKey: 'ammonia', displayLabel: 'Ammonia (TAN)', unit: 'mg/L', dataType: 'number', operationalMin: 0, operationalMax: 10, widgetType: 'gauge' }] },
          { typeKey: 'multi_parameter', displayName: 'Multi-Parameter Probe', category: 'water_quality', defaultChannels: [{ channelKey: 'temperature', displayLabel: 'Temperature', unit: '°C', dataType: 'number', operationalMin: 0, operationalMax: 40, widgetType: 'gauge' }, { channelKey: 'ph', displayLabel: 'pH', unit: 'pH', dataType: 'number', operationalMin: 0, operationalMax: 14, widgetType: 'gauge' }, { channelKey: 'dissolved_oxygen', displayLabel: 'DO', unit: 'mg/L', dataType: 'number', operationalMin: 0, operationalMax: 20, widgetType: 'gauge' }] }
        ]).replace(/'/g, "''")}',
        '${JSON.stringify({
          temperature: { warning: { low: 15, high: 30 }, critical: { low: 10, high: 35 } },
          ph: { warning: { low: 6.5, high: 8.5 }, critical: { low: 6.0, high: 9.0 } },
          dissolved_oxygen: { warning: { low: 4, high: null }, critical: { low: 2, high: null } }
        }).replace(/'/g, "''")}'
      )
      ON CONFLICT ("template_key") DO NOTHING
    `);

    // 6. Seed cold_chain template
    await queryRunner.query(`
      INSERT INTO "industry_templates" ("template_key", "display_name", "description", "icon", "sensor_types")
      VALUES (
        'cold_chain',
        'Cold Chain / Logistics',
        'Soğuk zincir lojistiği için sıcaklık, nem ve kapı durumu sensörleri.',
        'snowflake',
        '${JSON.stringify([
          { typeKey: 'fridge_temperature', displayName: 'Fridge Temperature Sensor', category: 'climate', defaultChannels: [{ channelKey: 'fridge_temp', displayLabel: 'Fridge Temperature', unit: '°C', dataType: 'number', operationalMin: -30, operationalMax: 10, widgetType: 'gauge' }] },
          { typeKey: 'humidity', displayName: 'Humidity Sensor', category: 'climate', defaultChannels: [{ channelKey: 'humidity', displayLabel: 'Humidity', unit: '%RH', dataType: 'number', operationalMin: 0, operationalMax: 100, widgetType: 'gauge' }] },
          { typeKey: 'door_sensor', displayName: 'Door Contact Sensor', category: 'mechanical', defaultChannels: [{ channelKey: 'door_status', displayLabel: 'Door Status', unit: '', dataType: 'boolean', widgetType: 'status' }] }
        ]).replace(/'/g, "''")}'
      )
      ON CONFLICT ("template_key") DO NOTHING
    `);

    // 7. Seed greenhouse template
    await queryRunner.query(`
      INSERT INTO "industry_templates" ("template_key", "display_name", "description", "icon", "sensor_types")
      VALUES (
        'greenhouse',
        'Greenhouse / Agriculture',
        'Sera ve tarım için toprak nemi, ışık, sıcaklık ve rüzgar sensörleri.',
        'leaf',
        '${JSON.stringify([
          { typeKey: 'soil_moisture', displayName: 'Soil Moisture Sensor', category: 'agriculture', defaultChannels: [{ channelKey: 'soil_moisture', displayLabel: 'Soil Moisture', unit: '%', dataType: 'number', operationalMin: 0, operationalMax: 100, widgetType: 'gauge' }] },
          { typeKey: 'light_sensor', displayName: 'Light Sensor', category: 'climate', defaultChannels: [{ channelKey: 'light_intensity', displayLabel: 'Light Intensity', unit: 'lux', dataType: 'number', operationalMin: 0, operationalMax: 100000, widgetType: 'sparkline' }] },
          { typeKey: 'wind_sensor', displayName: 'Wind Sensor', category: 'climate', defaultChannels: [{ channelKey: 'wind_speed', displayLabel: 'Wind Speed', unit: 'm/s', dataType: 'number', operationalMin: 0, operationalMax: 60, widgetType: 'gauge' }, { channelKey: 'wind_direction', displayLabel: 'Wind Direction', unit: '°', dataType: 'number', operationalMin: 0, operationalMax: 360, widgetType: 'gauge' }] }
        ]).replace(/'/g, "''")}'
      )
      ON CONFLICT ("template_key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sensors" DROP COLUMN IF EXISTS "type_definition_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_detection_log"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "industry_templates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sensor_type_definitions"`);
  }

  private async tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
    const result = await queryRunner.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
      [tableName],
    );
    return result[0]?.exists === true;
  }

  private async columnExists(queryRunner: QueryRunner, tableName: string, columnName: string): Promise<boolean> {
    const result = await queryRunner.query(
      `SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_name = $1 AND column_name = $2)`,
      [tableName, columnName],
    );
    return result[0]?.exists === true;
  }
}
```

**Step 2: Register migration in app.module.ts**

In `apps/sensor-service/src/app.module.ts`, add the new migration to the `migrations` array in `TypeOrmModule.forRootAsync()`.

**Step 3: Run migration to verify**

Run: `npx nx run sensor-service:migration:run` (or however migrations are executed)
Expected: Tables created, seed data inserted.

**Step 4: Commit**

```bash
git add apps/sensor-service/src/database/migrations/1740200000000-CreateDynamicSensorTypes.ts apps/sensor-service/src/app.module.ts
git commit -m "feat(sensor): add migration for dynamic sensor types, industry templates, detection log"
```

---

## Task 2: Backend Entities — New TypeORM + GraphQL Entities

**Files:**
- Create: `apps/sensor-service/src/database/entities/sensor-type-definition.entity.ts`
- Create: `apps/sensor-service/src/database/entities/industry-template.entity.ts`
- Create: `apps/sensor-service/src/database/entities/channel-detection-log.entity.ts`
- Modify: `apps/sensor-service/src/database/entities/sensor.entity.ts` (add `typeDefinitionId` + relation)

**Step 1: Write test for entity instantiation**

Create: `apps/sensor-service/src/database/entities/__tests__/sensor-type-definition.entity.spec.ts`

```typescript
import { SensorTypeDefinition } from '../sensor-type-definition.entity';

describe('SensorTypeDefinition', () => {
  it('should create an instance with required fields', () => {
    const entity = new SensorTypeDefinition();
    entity.tenantId = 'tenant-123';
    entity.typeKey = 'fridge_temperature';
    entity.displayName = 'Fridge Temperature Sensor';
    entity.category = 'climate';
    entity.industry = 'cold_chain';
    entity.isSystem = false;
    entity.defaultChannels = [{ channelKey: 'fridge_temp', unit: '°C' }];

    expect(entity.tenantId).toBe('tenant-123');
    expect(entity.typeKey).toBe('fridge_temperature');
    expect(entity.isSystem).toBe(false);
    expect(entity.defaultChannels).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest apps/sensor-service/src/database/entities/__tests__/sensor-type-definition.entity.spec.ts`
Expected: FAIL — module not found

**Step 3: Write SensorTypeDefinition entity**

```typescript
// apps/sensor-service/src/database/entities/sensor-type-definition.entity.ts
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import GraphQLJSON from 'graphql-type-json';

@ObjectType()
@Entity('sensor_type_definitions')
@Index(['tenantId', 'typeKey'], { unique: true })
export class SensorTypeDefinition {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ name: 'type_key', length: 100 })
  typeKey!: string;

  @Field()
  @Column({ name: 'display_name', length: 200 })
  displayName!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  icon?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  category?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  industry?: string;

  @Field()
  @Column({ name: 'is_system', default: false })
  isSystem!: boolean;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { name: 'default_channels', default: '[]' })
  defaultChannels?: Record<string, unknown>[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { default: '{}' })
  metadata?: Record<string, unknown>;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
```

**Step 4: Write IndustryTemplate entity**

```typescript
// apps/sensor-service/src/database/entities/industry-template.entity.ts
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import GraphQLJSON from 'graphql-type-json';

@ObjectType()
@Entity('industry_templates')
export class IndustryTemplate {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'template_key', length: 100, unique: true })
  templateKey!: string;

  @Field()
  @Column({ name: 'display_name', length: 200 })
  displayName!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  icon?: string;

  @Field(() => GraphQLJSON)
  @Column('jsonb', { name: 'sensor_types', default: '[]' })
  sensorTypes!: Record<string, unknown>[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { name: 'dashboard_layout', nullable: true })
  dashboardLayout?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { name: 'alert_presets', nullable: true })
  alertPresets?: Record<string, unknown>;

  @Field()
  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
```

**Step 5: Write ChannelDetectionLog entity**

```typescript
// apps/sensor-service/src/database/entities/channel-detection-log.entity.ts
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import GraphQLJSON from 'graphql-type-json';
import { Sensor } from './sensor.entity';

@ObjectType()
@Entity('channel_detection_log')
@Index(['tenantId'])
@Index(['sensorId'])
export class ChannelDetectionLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'sensor_id' })
  sensorId!: string;

  @ManyToOne(() => Sensor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sensor_id' })
  sensor?: Sensor;

  @Field(() => GraphQLJSON)
  @Column('jsonb', { name: 'raw_sample' })
  rawSample!: Record<string, unknown>;

  @Field(() => GraphQLJSON)
  @Column('jsonb', { name: 'ai_analysis' })
  aiAnalysis!: Record<string, unknown>;

  @Field(() => GraphQLJSON)
  @Column('jsonb', { name: 'proposed_channels' })
  proposedChannels!: Record<string, unknown>[];

  @Field({ nullable: true })
  @Column({ name: 'user_action', length: 20, nullable: true })
  userAction?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { name: 'final_channels', nullable: true })
  finalChannels?: Record<string, unknown>[];

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
```

**Step 6: Add typeDefinitionId to Sensor entity**

In `apps/sensor-service/src/database/entities/sensor.entity.ts`, add:

```typescript
@Field({ nullable: true })
@Column({ type: 'uuid', name: 'type_definition_id', nullable: true })
typeDefinitionId?: string;

@ManyToOne(() => SensorTypeDefinition, { nullable: true })
@JoinColumn({ name: 'type_definition_id' })
typeDefinition?: SensorTypeDefinition;
```

**Step 7: Register entities in app.module.ts**

Add `SensorTypeDefinition`, `IndustryTemplate`, `ChannelDetectionLog` to the entities array in `TypeOrmModule.forRootAsync()`.

**Step 8: Run tests, commit**

```bash
git add apps/sensor-service/src/database/entities/
git commit -m "feat(sensor): add entities for dynamic sensor types, templates, detection log"
```

---

## Task 3: Backend Module — SensorType + Template CRUD

**Files:**
- Create: `apps/sensor-service/src/sensor-type/sensor-type.module.ts`
- Create: `apps/sensor-service/src/sensor-type/sensor-type.service.ts`
- Create: `apps/sensor-service/src/sensor-type/sensor-type.resolver.ts`
- Create: `apps/sensor-service/src/sensor-type/dto/create-sensor-type.dto.ts`
- Create: `apps/sensor-service/src/sensor-type/dto/update-sensor-type.dto.ts`
- Create: `apps/sensor-service/src/sensor-type/__tests__/sensor-type.service.spec.ts`

**Step 1: Write failing test for SensorTypeService**

```typescript
// apps/sensor-service/src/sensor-type/__tests__/sensor-type.service.spec.ts
describe('SensorTypeService', () => {
  let service: SensorTypeService;
  let typeDefRepository: jest.Mocked<Repository<SensorTypeDefinition>>;
  let templateRepository: jest.Mocked<Repository<IndustryTemplate>>;
  let channelRepository: jest.Mocked<Repository<SensorDataChannel>>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SensorTypeService,
        { provide: getRepositoryToken(SensorTypeDefinition), useValue: { create: jest.fn(), save: jest.fn(), find: jest.fn(), findOne: jest.fn(), remove: jest.fn() } },
        { provide: getRepositoryToken(IndustryTemplate), useValue: { find: jest.fn(), findOne: jest.fn() } },
        { provide: getRepositoryToken(SensorDataChannel), useValue: { create: jest.fn(), save: jest.fn() } },
      ],
    }).compile();
    service = module.get(SensorTypeService);
    typeDefRepository = module.get(getRepositoryToken(SensorTypeDefinition));
    templateRepository = module.get(getRepositoryToken(IndustryTemplate));
    channelRepository = module.get(getRepositoryToken(SensorDataChannel));
  });

  describe('createSensorType', () => {
    it('should create a custom sensor type definition', async () => {
      const input = { typeKey: 'vibration', displayName: 'Vibration Sensor', category: 'mechanical' };
      typeDefRepository.create.mockReturnValue({ ...input, id: 'type-1', tenantId: 'tenant-1', isSystem: false } as any);
      typeDefRepository.save.mockResolvedValue({ ...input, id: 'type-1', tenantId: 'tenant-1', isSystem: false } as any);

      const result = await service.createSensorType('tenant-1', input);
      expect(result.typeKey).toBe('vibration');
      expect(result.isSystem).toBe(false);
    });

    it('should reject creating a system type', async () => {
      const input = { typeKey: 'ph', displayName: 'pH', isSystem: true };
      await expect(service.createSensorType('tenant-1', input as any)).rejects.toThrow();
    });
  });

  describe('getTemplates', () => {
    it('should return active industry templates', async () => {
      templateRepository.find.mockResolvedValue([{ id: '1', templateKey: 'aquaculture', isActive: true }] as any);
      const result = await service.getTemplates();
      expect(result).toHaveLength(1);
    });
  });

  describe('applyTemplate', () => {
    it('should create sensor type definitions from template for tenant', async () => {
      const template = {
        id: '1', templateKey: 'cold_chain', sensorTypes: [
          { typeKey: 'fridge_temperature', displayName: 'Fridge Temp', category: 'climate', defaultChannels: [{ channelKey: 'fridge_temp', unit: '°C' }] },
        ],
      };
      templateRepository.findOne.mockResolvedValue(template as any);
      typeDefRepository.create.mockImplementation((dto) => dto as any);
      typeDefRepository.save.mockImplementation((entity) => Promise.resolve({ id: 'new-type-1', ...entity }) as any);

      const result = await service.applyTemplate('tenant-1', 'cold_chain');
      expect(typeDefRepository.save).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest apps/sensor-service/src/sensor-type/__tests__/sensor-type.service.spec.ts`
Expected: FAIL — modules not found

**Step 3: Write DTOs**

```typescript
// apps/sensor-service/src/sensor-type/dto/create-sensor-type.dto.ts
@InputType()
export class CreateSensorTypeInput {
  @Field() @IsString() @IsNotEmpty() @MaxLength(100) typeKey!: string;
  @Field() @IsString() @IsNotEmpty() @MaxLength(200) displayName!: string;
  @Field({ nullable: true }) @IsString() @IsOptional() description?: string;
  @Field({ nullable: true }) @IsString() @IsOptional() @MaxLength(100) icon?: string;
  @Field({ nullable: true }) @IsString() @IsOptional() @MaxLength(100) category?: string;
  @Field({ nullable: true }) @IsString() @IsOptional() @MaxLength(100) industry?: string;
  @Field(() => GraphQLJSON, { nullable: true }) @IsOptional() defaultChannels?: Record<string, unknown>[];
  @Field(() => GraphQLJSON, { nullable: true }) @IsOptional() metadata?: Record<string, unknown>;
}

// apps/sensor-service/src/sensor-type/dto/update-sensor-type.dto.ts
@InputType()
export class UpdateSensorTypeInput {
  @Field({ nullable: true }) @IsString() @IsOptional() @MaxLength(200) displayName?: string;
  @Field({ nullable: true }) @IsString() @IsOptional() description?: string;
  @Field({ nullable: true }) @IsString() @IsOptional() @MaxLength(100) icon?: string;
  @Field({ nullable: true }) @IsString() @IsOptional() @MaxLength(100) category?: string;
  @Field(() => GraphQLJSON, { nullable: true }) @IsOptional() defaultChannels?: Record<string, unknown>[];
  @Field(() => GraphQLJSON, { nullable: true }) @IsOptional() metadata?: Record<string, unknown>;
}
```

**Step 4: Write SensorTypeService**

```typescript
// apps/sensor-service/src/sensor-type/sensor-type.service.ts
@Injectable()
export class SensorTypeService {
  constructor(
    @InjectRepository(SensorTypeDefinition) private readonly typeDefRepo: Repository<SensorTypeDefinition>,
    @InjectRepository(IndustryTemplate) private readonly templateRepo: Repository<IndustryTemplate>,
    @InjectRepository(SensorDataChannel) private readonly channelRepo: Repository<SensorDataChannel>,
  ) {}

  async getSensorTypes(tenantId: string): Promise<SensorTypeDefinition[]> {
    return this.typeDefRepo.find({ where: [{ tenantId }, { isSystem: true }], order: { displayName: 'ASC' } });
  }

  async createSensorType(tenantId: string, input: CreateSensorTypeInput): Promise<SensorTypeDefinition> {
    if ((input as any).isSystem) throw new BadRequestException('Cannot create system types');
    const entity = this.typeDefRepo.create({ ...input, tenantId, isSystem: false });
    return this.typeDefRepo.save(entity);
  }

  async updateSensorType(tenantId: string, id: string, input: UpdateSensorTypeInput): Promise<SensorTypeDefinition> {
    const existing = await this.typeDefRepo.findOne({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('Sensor type not found');
    if (existing.isSystem) throw new BadRequestException('Cannot modify system types');
    Object.assign(existing, input);
    return this.typeDefRepo.save(existing);
  }

  async deleteSensorType(tenantId: string, id: string): Promise<boolean> {
    const existing = await this.typeDefRepo.findOne({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('Sensor type not found');
    if (existing.isSystem) throw new BadRequestException('Cannot delete system types');
    await this.typeDefRepo.remove(existing);
    return true;
  }

  async getTemplates(): Promise<IndustryTemplate[]> {
    return this.templateRepo.find({ where: { isActive: true }, order: { displayName: 'ASC' } });
  }

  async applyTemplate(tenantId: string, templateKey: string): Promise<SensorTypeDefinition[]> {
    const template = await this.templateRepo.findOne({ where: { templateKey } });
    if (!template) throw new NotFoundException('Template not found');

    const created: SensorTypeDefinition[] = [];
    for (const sensorType of template.sensorTypes as any[]) {
      const existing = await this.typeDefRepo.findOne({ where: { tenantId, typeKey: sensorType.typeKey } });
      if (existing) { created.push(existing); continue; }
      const entity = this.typeDefRepo.create({
        tenantId,
        typeKey: sensorType.typeKey,
        displayName: sensorType.displayName,
        category: sensorType.category,
        industry: template.templateKey,
        isSystem: false,
        defaultChannels: sensorType.defaultChannels,
      });
      created.push(await this.typeDefRepo.save(entity));
    }
    return created;
  }

  // Used when a sensor is registered with a type — auto-create channels from defaultChannels
  async createChannelsFromTypeDefinition(sensorId: string, tenantId: string, typeDefinitionId: string): Promise<void> {
    const typeDef = await this.typeDefRepo.findOne({ where: { id: typeDefinitionId } });
    if (!typeDef?.defaultChannels) return;
    for (const [index, ch] of (typeDef.defaultChannels as any[]).entries()) {
      const channel = this.channelRepo.create({
        sensorId, tenantId,
        channelKey: ch.channelKey,
        displayLabel: ch.displayLabel || ch.channelKey,
        dataType: ch.dataType || 'number',
        unit: ch.unit,
        operationalMin: ch.operationalMin,
        operationalMax: ch.operationalMax,
        displaySettings: { widgetType: ch.widgetType || 'gauge' },
        discoverySource: 'template',
        isEnabled: true,
        displayOrder: index,
      });
      await this.channelRepo.save(channel);
    }
  }
}
```

**Step 5: Write GraphQL Resolver**

```typescript
// apps/sensor-service/src/sensor-type/sensor-type.resolver.ts
@Resolver(() => SensorTypeDefinition)
export class SensorTypeResolver {
  constructor(private readonly sensorTypeService: SensorTypeService) {}

  @Query(() => [SensorTypeDefinition], { name: 'sensorTypes' })
  async getSensorTypes(@Tenant() tenantId: string) {
    return this.sensorTypeService.getSensorTypes(tenantId);
  }

  @Query(() => [IndustryTemplate], { name: 'industryTemplates' })
  async getTemplates() {
    return this.sensorTypeService.getTemplates();
  }

  @Mutation(() => SensorTypeDefinition, { name: 'createSensorType' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createSensorType(@Args('input') input: CreateSensorTypeInput, @Tenant() tenantId: string) {
    return this.sensorTypeService.createSensorType(tenantId, input);
  }

  @Mutation(() => SensorTypeDefinition, { name: 'updateSensorType' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateSensorType(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateSensorTypeInput,
    @Tenant() tenantId: string,
  ) {
    return this.sensorTypeService.updateSensorType(tenantId, id, input);
  }

  @Mutation(() => Boolean, { name: 'deleteSensorType' })
  @Roles(Role.TENANT_ADMIN)
  async deleteSensorType(@Args('id', { type: () => ID }) id: string, @Tenant() tenantId: string) {
    return this.sensorTypeService.deleteSensorType(tenantId, id);
  }

  @Mutation(() => [SensorTypeDefinition], { name: 'applyIndustryTemplate' })
  @Roles(Role.TENANT_ADMIN)
  async applyTemplate(
    @Args('templateKey') templateKey: string,
    @Tenant() tenantId: string,
  ) {
    return this.sensorTypeService.applyTemplate(tenantId, templateKey);
  }
}
```

**Step 6: Write module, register in app.module.ts**

```typescript
// apps/sensor-service/src/sensor-type/sensor-type.module.ts
@Module({
  imports: [TypeOrmModule.forFeature([SensorTypeDefinition, IndustryTemplate, SensorDataChannel])],
  providers: [SensorTypeService, SensorTypeResolver],
  exports: [SensorTypeService],
})
export class SensorTypeModule {}
```

**Step 7: Run tests, commit**

```bash
git add apps/sensor-service/src/sensor-type/
git commit -m "feat(sensor): add sensor type definitions and industry template CRUD"
```

---

## Task 4: AI Service — Channel Detection Tools

**Files:**
- Create: `apps/ai-service/src/tools/sensor-config/analyze-sensor-data.tool.ts`
- Create: `apps/ai-service/src/tools/sensor-config/suggest-channels.tool.ts`
- Create: `apps/ai-service/src/tools/sensor-config/sensor-config-tools.module.ts`
- Create: `apps/ai-service/src/tools/sensor-config/__tests__/analyze-sensor-data.tool.spec.ts`

**Step 1: Write failing test**

```typescript
// apps/ai-service/src/tools/sensor-config/__tests__/analyze-sensor-data.tool.spec.ts
describe('AnalyzeSensorDataTool', () => {
  let tool: AnalyzeSensorDataTool;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [AnalyzeSensorDataTool],
    }).compile();
    tool = module.get(AnalyzeSensorDataTool);
  });

  it('should have correct metadata', () => {
    const meta = tool.getMetadata();
    expect(meta.name).toBe('analyze_sensor_data');
    expect(meta.category).toBe('sensor_query');
  });

  it('should detect numeric float patterns as potential measurements', async () => {
    const input = {
      samples: [
        { timestamp: '2026-02-21T10:00:00Z', values: { temp: 22.5, hum: 65.3, door: true } },
        { timestamp: '2026-02-21T10:01:00Z', values: { temp: 22.7, hum: 65.1, door: true } },
        { timestamp: '2026-02-21T10:02:00Z', values: { temp: 22.6, hum: 64.8, door: false } },
      ],
    };
    const ctx = { tenantId: 't1', schemaName: 'tenant_t1', userId: 'u1', userRoles: ['operator'], correlationId: 'c1', persona: 'operator' };
    const result = await tool.execute(input, ctx);

    expect(result.success).toBe(true);
    expect(result.data.detectedFields).toContainEqual(expect.objectContaining({ key: 'temp', dataType: 'number' }));
    expect(result.data.detectedFields).toContainEqual(expect.objectContaining({ key: 'hum', dataType: 'number' }));
    expect(result.data.detectedFields).toContainEqual(expect.objectContaining({ key: 'door', dataType: 'boolean' }));
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Write AnalyzeSensorDataTool**

This tool does **local pattern analysis** — no LLM call needed. It examines raw data samples and detects field types, ranges, and likely identities:

```typescript
// apps/ai-service/src/tools/sensor-config/analyze-sensor-data.tool.ts
@Injectable()
@Tool({
  name: 'analyze_sensor_data',
  description: 'Analyze raw sensor data samples to detect field types, value ranges, and suggest what each field might represent. Used for auto-configuring sensor channels.',
  category: 'sensor_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  inputSchema: {
    type: 'object',
    properties: {
      samples: {
        type: 'array',
        description: 'Array of raw data samples from the sensor. Each sample should have a timestamp and a values object.',
        items: { type: 'object', properties: { timestamp: { type: 'string' }, values: { type: 'object' } } },
      },
      sensorName: { type: 'string', description: 'Optional name or label of the sensor for context' },
      mqttTopic: { type: 'string', description: 'Optional MQTT topic the data arrived on, for additional context' },
    },
    required: ['samples'],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class AnalyzeSensorDataTool extends BaseTool<AnalyzeInput, AnalyzeOutput> {
  protected async run(input: AnalyzeInput, _ctx: ToolExecutionContext): Promise<AnalyzeOutput> {
    const { samples, sensorName, mqttTopic } = input;
    if (!samples?.length) return { detectedFields: [], sampleCount: 0, confidence: 'low' };

    const fieldAnalysis = new Map<string, FieldStats>();

    for (const sample of samples) {
      if (!sample.values) continue;
      for (const [key, value] of Object.entries(sample.values)) {
        if (!fieldAnalysis.has(key)) {
          fieldAnalysis.set(key, { values: [], types: new Set() });
        }
        const stats = fieldAnalysis.get(key)!;
        stats.values.push(value);
        stats.types.add(typeof value);
      }
    }

    const detectedFields = [];
    for (const [key, stats] of fieldAnalysis) {
      const dataType = this.inferDataType(stats);
      const range = dataType === 'number' ? this.computeRange(stats.values as number[]) : undefined;
      const suggestedUnit = this.guessUnit(key, range);
      const suggestedLabel = this.formatLabel(key);

      detectedFields.push({
        key,
        dataType,
        sampleCount: stats.values.length,
        ...(range && { min: range.min, max: range.max, mean: range.mean }),
        suggestedUnit,
        suggestedLabel,
        suggestedWidgetType: dataType === 'boolean' ? 'status' : 'gauge',
      });
    }

    return {
      detectedFields,
      sampleCount: samples.length,
      confidence: samples.length >= 10 ? 'high' : samples.length >= 3 ? 'medium' : 'low',
      context: { sensorName, mqttTopic },
    };
  }

  private inferDataType(stats: FieldStats): string {
    if (stats.types.has('boolean') && stats.types.size === 1) return 'boolean';
    if (stats.types.has('number') && !stats.types.has('string')) return 'number';
    if (stats.types.has('string') && stats.types.size === 1) return 'string';
    return 'string';
  }

  private computeRange(values: number[]) {
    const nums = values.filter((v) => typeof v === 'number' && !isNaN(v));
    if (!nums.length) return undefined;
    return {
      min: Math.min(...nums),
      max: Math.max(...nums),
      mean: Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100,
    };
  }

  private guessUnit(key: string, range?: { min: number; max: number }): string | undefined {
    const k = key.toLowerCase();
    if (k.includes('temp')) return '°C';
    if (k.includes('hum') || k.includes('moisture')) return '%RH';
    if (k.includes('ph')) return 'pH';
    if (k.includes('pressure')) return 'hPa';
    if (k.includes('wind') && k.includes('speed')) return 'm/s';
    if (k.includes('wind') && k.includes('dir')) return '°';
    if (k.includes('light') || k.includes('lux')) return 'lux';
    if (k.includes('voltage') || k.includes('volt')) return 'V';
    if (k.includes('current') || k.includes('amp')) return 'A';
    if (k.includes('power') || k.includes('watt')) return 'W';
    if (k.includes('vibr')) return 'mm/s';
    if (k.includes('do') || k.includes('oxygen')) return 'mg/L';
    if (k.includes('salinity') || k.includes('tds')) return 'ppt';
    if (range && range.min >= 0 && range.max <= 14) return 'pH';
    return undefined;
  }

  private formatLabel(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^\s/, '').split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
}
```

**Step 4: Write SuggestChannelsTool**

This tool takes the analysis output and creates structured channel proposals. This IS an LLM-powered tool — it uses the AI context to make intelligent suggestions when simple heuristics aren't enough:

```typescript
// apps/ai-service/src/tools/sensor-config/suggest-channels.tool.ts
@Injectable()
@Tool({
  name: 'suggest_sensor_channels',
  description: 'Given analyzed sensor data fields, suggest optimal channel configurations including units, ranges, alert thresholds, and widget types. Returns a channel proposal for user approval.',
  category: 'sensor_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  inputSchema: {
    type: 'object',
    properties: {
      sensorId: { type: 'string', description: 'The sensor ID to create channel proposals for' },
      detectedFields: { type: 'array', description: 'Output from analyze_sensor_data tool' },
      industryContext: { type: 'string', description: 'Optional industry context (aquaculture, cold_chain, greenhouse, etc.)' },
    },
    required: ['sensorId', 'detectedFields'],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class SuggestChannelsTool extends BaseTool<SuggestInput, SuggestOutput> {
  protected async run(input: SuggestInput, ctx: ToolExecutionContext): Promise<SuggestOutput> {
    const proposals = input.detectedFields.map((field: any) => ({
      channelKey: field.key,
      displayLabel: field.suggestedLabel,
      dataType: field.dataType,
      unit: field.suggestedUnit || '',
      operationalMin: field.min ?? 0,
      operationalMax: field.max ?? 100,
      widgetType: field.suggestedWidgetType || 'gauge',
      alertThresholds: this.suggestAlertThresholds(field),
      confidence: field.suggestedUnit ? 'high' : 'medium',
    }));

    return {
      sensorId: input.sensorId,
      tenantId: ctx.tenantId,
      proposals,
      industryContext: input.industryContext,
    };
  }

  private suggestAlertThresholds(field: any) {
    if (field.dataType !== 'number' || !field.min || !field.max) return null;
    const range = field.max - field.min;
    return {
      warning: { low: field.min + range * 0.1, high: field.max - range * 0.1 },
      critical: { low: field.min, high: field.max },
    };
  }
}
```

**Step 5: Write module**

```typescript
// apps/ai-service/src/tools/sensor-config/sensor-config-tools.module.ts
@Module({
  providers: [AnalyzeSensorDataTool, SuggestChannelsTool],
  exports: [AnalyzeSensorDataTool, SuggestChannelsTool],
})
export class SensorConfigToolsModule {}
```

Register in `apps/ai-service/src/tools/tool-registry.module.ts`.

**Step 6: Run tests, commit**

```bash
git add apps/ai-service/src/tools/sensor-config/
git commit -m "feat(ai): add sensor data analysis and channel suggestion tools"
```

---

## Task 5: Backend — Channel Detection Endpoint

**Files:**
- Create: `apps/sensor-service/src/sensor-type/channel-detection.service.ts`
- Create: `apps/sensor-service/src/sensor-type/__tests__/channel-detection.service.spec.ts`
- Modify: `apps/sensor-service/src/sensor-type/sensor-type.resolver.ts`

**Step 1: Write failing test**

```typescript
describe('ChannelDetectionService', () => {
  it('should buffer samples and call AI service for analysis', async () => { ... });
  it('should store detection log with AI analysis', async () => { ... });
  it('should create channels when user approves proposal', async () => { ... });
  it('should reject proposal and log user_action as rejected', async () => { ... });
});
```

**Step 2: Write ChannelDetectionService**

This service:
1. Accepts raw sensor data samples
2. Calls AI service `/api/v2/ai/chat` with `analyze_sensor_data` + `suggest_sensor_channels` tool context
3. Stores proposal in `channel_detection_log`
4. On approval: creates `sensor_data_channels` entries
5. On rejection: updates log with `user_action = 'rejected'`

Key methods:
- `detectChannels(sensorId, tenantId, samples)` → returns proposal
- `approveProposal(proposalId, tenantId, modifications?)` → creates channels
- `rejectProposal(proposalId, tenantId)` → logs rejection
- `getPendingProposals(sensorId, tenantId)` → lists unapproved proposals

**Step 3: Add resolver mutations**

```graphql
detectSensorChannels(sensorId: ID!, samples: JSON!): ChannelDetectionLog!
approveChannelProposal(proposalId: ID!, modifications: JSON): [SensorDataChannel!]!
rejectChannelProposal(proposalId: ID!): Boolean!
pendingChannelProposals(sensorId: ID!): [ChannelDetectionLog!]!
```

**Step 4: Run tests, commit**

```bash
git commit -m "feat(sensor): add AI-powered channel detection service"
```

---

## Task 6: Frontend — Industry Template Selection

**Files:**
- Create: `web/modules/sensor-module/src/components/templates/IndustryTemplateSelector.tsx`
- Create: `web/modules/sensor-module/src/hooks/useIndustryTemplates.ts`
- Create: `web/modules/sensor-module/src/pages/IndustrySetupPage.tsx`
- Modify: `web/modules/sensor-module/src/Module.tsx` (add route)

**Step 1: Write useIndustryTemplates hook**

```typescript
// web/modules/sensor-module/src/hooks/useIndustryTemplates.ts
export function useIndustryTemplates() {
  // GraphQL query: industryTemplates { id, templateKey, displayName, description, icon, sensorTypes }
  // Returns { templates, loading, error }
}

export function useApplyTemplate() {
  // GraphQL mutation: applyIndustryTemplate(templateKey) { id, typeKey, displayName }
  // Returns { apply, loading, error }
}
```

**Step 2: Write IndustryTemplateSelector component**

Card-based selector showing available templates (Aquaculture, Cold Chain, Greenhouse, Custom). Each card shows template icon, name, description, and sensor type count. Clicking applies the template.

**Step 3: Write IndustrySetupPage**

Route: `/sensor/setup`
Shows `IndustryTemplateSelector` + option to skip and configure manually.

**Step 4: Add route in Module.tsx**

**Step 5: Commit**

```bash
git commit -m "feat(sensor-ui): add industry template selection page"
```

---

## Task 7: Frontend — Custom Channel Management UI

**Files:**
- Create: `web/modules/sensor-module/src/components/channels/ChannelManagerPanel.tsx`
- Create: `web/modules/sensor-module/src/hooks/useChannelManagement.ts`
- Modify: `web/modules/sensor-module/src/pages/DeviceDetailPage.tsx` (add channel management tab)

**Step 1: Write useChannelManagement hook**

```typescript
export function useChannelManagement(sensorId: string) {
  // CRUD operations for sensor channels
  // createChannel(input) → POST mutation
  // updateChannel(id, input) → PATCH mutation
  // deleteChannel(id) → DELETE mutation
  // channels → query list
}
```

**Step 2: Write ChannelManagerPanel**

Shows list of existing channels with edit/delete. "Add Channel" button opens the existing `ChannelEditorModal`. Uses the same form pattern (plain React state + controlled components).

**Step 3: Integrate into DeviceDetailPage**

Add a "Channels" tab that renders `ChannelManagerPanel`.

**Step 4: Commit**

```bash
git commit -m "feat(sensor-ui): add channel management panel to device detail"
```

---

## Task 8: Frontend — AI Channel Detection UI

**Files:**
- Create: `web/modules/sensor-module/src/components/channels/AIChannelProposalCard.tsx`
- Create: `web/modules/sensor-module/src/components/channels/AIDetectionPanel.tsx`
- Create: `web/modules/sensor-module/src/hooks/useChannelDetection.ts`

**Step 1: Write useChannelDetection hook**

```typescript
export function useChannelDetection(sensorId: string) {
  // detectChannels() → triggers AI analysis
  // proposals → pending proposals list
  // approveProposal(id, modifications?) → approves
  // rejectProposal(id) → rejects
}
```

**Step 2: Write AIChannelProposalCard**

Shows one AI proposal with:
- Detected field name, type, range
- AI confidence badge (high/medium/low)
- Suggested unit, widget type
- Edit button (pre-fills ChannelEditorModal)
- Approve / Reject buttons

**Step 3: Write AIDetectionPanel**

"Auto-Detect Channels" button triggers detection. Shows loading state while AI analyzes. Renders list of `AIChannelProposalCard` when proposals arrive. Bulk approve/reject actions.

**Step 4: Integrate into DeviceDetailPage and registration wizard**

Add `AIDetectionPanel` to:
1. DeviceDetailPage channels tab (for existing sensors)
2. `DataChannelsStep` in registration wizard (enhance existing auto-discovery with AI)

**Step 5: Commit**

```bash
git commit -m "feat(sensor-ui): add AI-powered channel detection UI"
```

---

## Task 9: Integration — Wire Sensor Registration to Dynamic Types

**Files:**
- Modify: `apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts`
- Modify: `apps/sensor-service/src/sensor/dto/create-sensor.dto.ts`
- Modify: `web/modules/sensor-module/src/components/registration/steps/BasicInfoStep.tsx`

**Step 1: Update CreateSensorInput DTO**

Add optional `typeDefinitionId` field alongside existing `type` field. When `typeDefinitionId` is provided, auto-create channels from the type definition's `defaultChannels`.

**Step 2: Update sensor resolver createSensor mutation**

After sensor creation, if `typeDefinitionId` is provided, call `sensorTypeService.createChannelsFromTypeDefinition()`.

**Step 3: Update BasicInfoStep frontend**

Replace hardcoded sensor type dropdown with dynamic list from `sensorTypes` GraphQL query. Show both system types and tenant custom types.

**Step 4: Run full test suite, commit**

```bash
git commit -m "feat(sensor): wire sensor registration to dynamic type definitions"
```

---

## Task 10: Backward Compatibility — Seed Existing ENUM Values

**Files:**
- Modify: `apps/sensor-service/src/database/migrations/1740200000000-CreateDynamicSensorTypes.ts`

**Step 1: Add migration step to seed system type definitions from existing ENUM**

For each value in the existing `SensorType` enum (temperature, ph, dissolved_oxygen, etc.), create a system `sensor_type_definition` entry with `is_system = true` and a special `tenant_id = '00000000-0000-0000-0000-000000000000'` (system tenant).

**Step 2: Backfill `type_definition_id` for existing sensors**

```sql
UPDATE sensors s SET type_definition_id = std.id
FROM sensor_type_definitions std
WHERE std.type_key = s.type::text AND std.is_system = true;
```

**Step 3: Commit**

```bash
git commit -m "feat(sensor): seed system type definitions from existing enum values"
```

---

## Dependency Graph

```
Task 1 (Migration) ──► Task 2 (Entities) ──► Task 3 (Backend CRUD)
                                                      │
                                                      ├──► Task 5 (Detection Endpoint) ──► Task 8 (AI Detection UI)
                                                      │
                                                      ├──► Task 6 (Template UI)
                                                      │
                                                      └──► Task 7 (Channel Management UI)

Task 4 (AI Tools) ──► Task 5 (Detection Endpoint)

Task 3 + Task 10 ──► Task 9 (Registration Integration)
```

Tasks 4, 6, 7 can run in parallel after Task 3 is done.