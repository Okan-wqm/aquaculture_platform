import { ObjectType, Field, Int, Float, InputType } from '@nestjs/graphql';

/**
 * Tenant statistics response
 */
@ObjectType()
export class TenantStats {
  @Field(() => Int)
  totalUsers: number;

  @Field(() => Int)
  activeUsers: number;

  @Field(() => Int)
  pendingUsers: number;

  @Field(() => Int)
  inactiveUsers: number;

  @Field(() => Int)
  totalModules: number;

  @Field(() => Int)
  activeModules: number;

  @Field(() => Int)
  activeSessions: number;

  @Field(() => Float, { nullable: true })
  monthlyGrowthPercent?: number;

  @Field()
  lastActivityAt: Date;
}

/**
 * Table information in database
 */
@ObjectType()
export class TableInfo {
  @Field()
  name: string;

  @Field(() => Int)
  rowCount: number;

  @Field()
  size: string;

  @Field(() => Int)
  indexCount: number;

  @Field()
  lastModified: Date;
}

/**
 * Database information response
 */
@ObjectType()
export class TenantDatabaseInfo {
  @Field()
  databaseName: string;

  @Field()
  schemaName: string;

  @Field()
  totalSize: string;

  @Field(() => Int)
  tableCount: number;

  @Field()
  status: string;

  @Field(() => Date, { nullable: true })
  lastBackup?: Date | null;

  @Field(() => Int)
  activeConnections: number;

  @Field(() => Int)
  maxConnections: number;

  @Field()
  databaseType: string;

  @Field()
  region: string;

  @Field()
  isolationLevel: string;

  @Field()
  encryption: string;

  @Field(() => [TableInfo])
  tables: TableInfo[];
}

/**
 * Column information for table schema
 */
@ObjectType()
export class ColumnInfo {
  @Field()
  columnName: string;

  @Field()
  dataType: string;

  @Field()
  isNullable: boolean;

  @Field({ nullable: true })
  columnDefault?: string;

  @Field()
  isPrimaryKey: boolean;

  @Field()
  isForeignKey: boolean;

  @Field({ nullable: true })
  foreignKeyTable?: string;

  @Field({ nullable: true })
  foreignKeyColumn?: string;
}

/**
 * Index information for table schema
 */
@ObjectType()
export class IndexInfo {
  @Field()
  indexName: string;

  @Field()
  columnName: string;

  @Field()
  isUnique: boolean;

  @Field()
  isPrimary: boolean;
}

/**
 * Table schema information response
 */
@ObjectType()
export class TableSchemaInfo {
  @Field()
  tableName: string;

  @Field()
  schemaName: string;

  @Field(() => [ColumnInfo])
  columns: ColumnInfo[];

  @Field(() => [IndexInfo])
  indexes: IndexInfo[];
}

/**
 * Input for table schema query
 */
@InputType()
export class TableSchemaInput {
  @Field()
  schemaName: string;

  @Field()
  tableName: string;
}
