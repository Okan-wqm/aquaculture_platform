import { ObjectType, Field, Int, Float, InputType } from '@nestjs/graphql';
import { IsString, MaxLength, Matches } from 'class-validator';
import { GraphQLJSON } from 'graphql-type-json';

/**
 * Tenant statistics response
 */
@ObjectType()
export class TenantStats {
  @Field(() => Int)
  totalUsers!: number;

  @Field(() => Int)
  activeUsers!: number;

  @Field(() => Int)
  pendingUsers!: number;

  @Field(() => Int)
  inactiveUsers!: number;

  @Field(() => Int)
  totalModules!: number;

  @Field(() => Int)
  activeModules!: number;

  @Field(() => Int)
  activeSessions!: number;

  @Field(() => Float, { nullable: true })
  monthlyGrowthPercent?: number;

  @Field()
  lastActivityAt!: Date;
}

/**
 * Table information in database
 */
@ObjectType()
export class TableInfo {
  @Field()
  name!: string;

  @Field(() => Int)
  rowCount!: number;

  @Field()
  size!: string;

  @Field(() => Int)
  indexCount!: number;

  @Field()
  lastModified!: Date;
}

/**
 * Database information response
 */
@ObjectType()
export class TenantDatabaseInfo {
  @Field()
  databaseName!: string;

  @Field()
  schemaName!: string;

  @Field()
  totalSize!: string;

  @Field(() => Int)
  tableCount!: number;

  @Field()
  status!: string;

  @Field(() => Date, { nullable: true })
  lastBackup?: Date | null;

  @Field(() => Int)
  activeConnections!: number;

  @Field(() => Int)
  maxConnections!: number;

  @Field()
  databaseType!: string;

  @Field()
  region!: string;

  @Field()
  isolationLevel!: string;

  @Field()
  encryption!: string;

  @Field(() => [TableInfo])
  tables!: TableInfo[];
}

/**
 * Column information for table schema
 */
@ObjectType()
export class ColumnInfo {
  @Field()
  columnName!: string;

  @Field()
  dataType!: string;

  @Field()
  isNullable!: boolean;

  @Field({ nullable: true })
  columnDefault?: string;

  @Field()
  isPrimaryKey!: boolean;

  @Field()
  isForeignKey!: boolean;

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
  indexName!: string;

  @Field()
  columnName!: string;

  @Field()
  isUnique!: boolean;

  @Field()
  isPrimary!: boolean;
}

/**
 * Table schema information response
 */
@ObjectType()
export class TableSchemaInfo {
  @Field()
  tableName!: string;

  @Field()
  schemaName!: string;

  @Field(() => [ColumnInfo])
  columns!: ColumnInfo[];

  @Field(() => [IndexInfo])
  indexes!: IndexInfo[];
}

// ============================================================================
// Audit Log Types
// ============================================================================

@ObjectType()
export class AuditLogEntryResponse {
  @Field()
  id!: string;

  @Field()
  performedBy!: string;

  @Field({ nullable: true })
  performedByEmail?: string;

  @Field()
  action!: string;

  @Field()
  entityType!: string;

  @Field({ nullable: true })
  entityId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  details?: Record<string, unknown>;

  @Field()
  severity!: string;

  @Field({ nullable: true })
  ipAddress?: string;

  @Field({ nullable: true })
  userAgent?: string;

  @Field()
  createdAt!: Date;
}

@ObjectType()
export class AuditLogPage {
  @Field(() => [AuditLogEntryResponse])
  data!: AuditLogEntryResponse[];

  @Field(() => Int)
  total!: number;
}

// ============================================================================
// Tenant Activity Types
// ============================================================================

@ObjectType()
export class RecentLoginResponse {
  @Field()
  id!: string;

  @Field()
  userId!: string;

  @Field()
  email!: string;

  @Field({ nullable: true })
  firstName?: string;

  @Field({ nullable: true })
  lastName?: string;

  @Field()
  loginAt!: Date;

  @Field({ nullable: true })
  ipAddress?: string;

  @Field({ nullable: true })
  userAgent?: string;

  @Field({ nullable: true })
  deviceType?: string;

  @Field()
  success!: boolean;
}

@ObjectType()
export class UserActivitySummaryResponse {
  @Field()
  userId!: string;

  @Field()
  email!: string;

  @Field({ nullable: true })
  firstName?: string;

  @Field({ nullable: true })
  lastName?: string;

  @Field(() => Int)
  totalActions!: number;

  @Field({ nullable: true })
  lastActiveAt?: Date;

  @Field(() => Int)
  loginCount!: number;
}

@ObjectType()
export class DailyActiveUsersResponse {
  @Field()
  date!: string;

  @Field(() => Int)
  count!: number;
}

@ObjectType()
export class TenantActivityResponse {
  @Field(() => [RecentLoginResponse])
  recentLogins!: RecentLoginResponse[];

  @Field(() => Int)
  activeSessions!: number;

  @Field(() => [UserActivitySummaryResponse])
  userActivitySummaries!: UserActivitySummaryResponse[];

  @Field(() => [DailyActiveUsersResponse])
  dailyActiveUsers!: DailyActiveUsersResponse[];
}

// ============================================================================
// Module Usage Stats Types
// ============================================================================

@ObjectType()
export class ModuleUsageStatResponse {
  @Field()
  moduleCode!: string;

  @Field(() => Int)
  userCount!: number;

  @Field({ nullable: true })
  lastAccessAt?: Date;

  @Field(() => Int)
  actionsThisMonth!: number;

  @Field(() => Int)
  actionsLastMonth!: number;
}

/**
 * SQL identifier pattern - prevents SQL injection
 * Must start with letter/underscore, contain only alphanumeric/underscore
 */
const SQL_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SQL_IDENTIFIER_MSG = 'Must be a valid SQL identifier (letters, numbers, underscores only, must start with letter/underscore)';

/**
 * Input for table schema query
 * SECURITY: Schema and table names are validated to prevent SQL injection
 */
@InputType()
export class TableSchemaInput {
  @Field()
  @IsString()
  @MaxLength(63, { message: 'Schema name must be at most 63 characters' })
  @Matches(SQL_IDENTIFIER_PATTERN, { message: `schemaName: ${SQL_IDENTIFIER_MSG}` })
  schemaName!: string;

  @Field()
  @IsString()
  @MaxLength(63, { message: 'Table name must be at most 63 characters' })
  @Matches(SQL_IDENTIFIER_PATTERN, { message: `tableName: ${SQL_IDENTIFIER_MSG}` })
  tableName!: string;
}
