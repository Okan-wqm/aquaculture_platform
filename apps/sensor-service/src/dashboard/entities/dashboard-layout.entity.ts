import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

/**
 * Widget position in GridStack grid
 */
export interface GridPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Selected data channel info stored in widget config
 */
export interface SelectedChannel {
  id: string;
  channelKey: string;
  displayLabel: string;
  unit?: string;
  sensorId: string;
  sensorName: string;
}

/**
 * Widget configuration stored in dashboard layout
 */
export interface WidgetConfig {
  id: string;
  type: string; // 'gauge' | 'line-chart' | 'sparkline' | 'stat-card' | 'table' | 'alert'
  title: string;
  dataChannelIds?: string[];
  selectedChannels?: SelectedChannel[];
  // Legacy fields for backward compatibility
  sensorIds?: string[];
  metric?: string;
  timeRange: string; // 'live' | '1h' | '6h' | '24h' | '7d' | '30d'
  refreshInterval: number; // ms
  gridPosition: GridPosition;
  settings?: {
    showLegend?: boolean;
    showGrid?: boolean;
    colorScheme?: string;
    aggregation?: string;
    decimalPlaces?: number;
  };
}

/**
 * Dashboard Layout entity - stores user dashboard configurations
 * Each tenant can have system default and users can have personal layouts
 */
@ObjectType()
@Entity('dashboard_layouts')
@Index(['tenantId'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'isSystemDefault'])
export class DashboardLayout {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Field({ nullable: true })
  @Column({ name: 'user_id', nullable: true })
  userId?: string;

  @Field()
  @Column()
  name: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', default: [] })
  widgets: WidgetConfig[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true, name: 'process_background' })
  processBackground: {
    processId: string | null;
    position: { x: number; y: number };
    scale: number;
    opacity: number;
  } | null;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true, name: 'grid_config' })
  gridConfig: {
    columns: number;
    cellHeight: number;
    margin: number;
  } | null;

  @Field({ nullable: true })
  @Column({ type: 'int', default: 1, name: 'grid_version' })
  gridVersion: number;

  @Field()
  @Column({ name: 'is_default', default: false })
  isDefault: boolean;

  @Field()
  @Column({ name: 'is_system_default', default: false })
  isSystemDefault: boolean;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;
}
