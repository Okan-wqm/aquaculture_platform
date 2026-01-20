import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
} from 'typeorm';

/**
 * Setting category for organization
 */
export enum SettingCategory {
  GENERAL = 'general',
  SECURITY = 'security',
  EMAIL = 'email',
  SMS = 'sms',
  BILLING = 'billing',
  RATE_LIMIT = 'rate_limit',
  STORAGE = 'storage',
  INTEGRATION = 'integration',
  NOTIFICATION = 'notification',
  FEATURE_FLAG = 'feature_flag',
  MAINTENANCE = 'maintenance',
}

/**
 * Setting value type
 */
export enum SettingValueType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  JSON = 'json',
  ENCRYPTED = 'encrypted', // For sensitive values
}

/**
 * System-wide settings entity
 * Persisted to database with caching support
 */
@Entity('system_settings')
@Index(['key'], { unique: true })
@Index(['category'])
export class SystemSetting {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  key!: string;

  @Column('text')
  value!: string; // Stored as string, parsed based on valueType

  @Column({ type: 'enum', enum: SettingValueType, default: SettingValueType.STRING })
  valueType!: SettingValueType;

  @Column({ type: 'enum', enum: SettingCategory })
  category!: SettingCategory;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ nullable: true })
  displayName?: string;

  @Column({ default: false })
  isPublic!: boolean; // Can be read without admin privileges

  @Column({ default: false })
  isReadOnly!: boolean; // Cannot be changed via API

  @Column({ default: false })
  requiresRestart!: boolean; // System restart needed after change

  @Column({ type: 'text', nullable: true })
  defaultValue?: string;

  @Column({ type: 'text', nullable: true })
  validationRule?: string; // JSON schema or regex for validation

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version!: number;
}

/**
 * Email template entity
 */
@Entity('email_templates')
@Index(['code'], { unique: true })
@Index(['category'])
export class EmailTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  code!: string; // e.g., 'welcome', 'password_reset', 'invoice'

  @Column()
  name!: string;

  @Column({ nullable: true })
  description?: string;

  @Column()
  category!: string; // 'auth', 'billing', 'notification', 'marketing'

  @Column()
  subject!: string;

  @Column('text')
  bodyHtml!: string;

  @Column('text', { nullable: true })
  bodyText?: string; // Plain text version

  @Column('jsonb', { default: '[]' })
  variables!: EmailTemplateVariable[]; // Available template variables

  @Column({ default: true })
  isActive!: boolean;

  @Column({ default: false })
  isSystem!: boolean; // System templates cannot be deleted

  @Column({ nullable: true })
  tenantId?: string; // null = global template

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ nullable: true })
  updatedBy?: string;
}

export interface EmailTemplateVariable {
  name: string;
  description: string;
  required: boolean;
  defaultValue?: string;
}

/**
 * IP Access Rule entity for whitelist/blacklist
 */
@Entity('ip_access_rules')
@Index(['ipAddress'])
@Index(['tenantId'])
@Index(['ruleType'])
export class IpAccessRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: true })
  tenantId?: string; // null = global rule

  @Column()
  ipAddress!: string; // Can be CIDR notation: 192.168.1.0/24

  @Column({ type: 'varchar', length: 20 })
  ruleType!: 'whitelist' | 'blacklist';

  @Column({ nullable: true })
  description?: string;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date; // null = never expires

  @Column({ type: 'int', default: 0 })
  hitCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastHitAt?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ nullable: true })
  createdBy?: string;
}

// ============================================================================
// Default System Settings
// ============================================================================

export interface DefaultSystemSettings {
  key: string;
  value: string;
  valueType: SettingValueType;
  category: SettingCategory;
  description: string;
  displayName: string;
  isPublic?: boolean;
  isReadOnly?: boolean;
  requiresRestart?: boolean;
}

export const DEFAULT_SYSTEM_SETTINGS: DefaultSystemSettings[] = [
  // General Settings
  {
    key: 'platform.name',
    value: 'Aquaculture Platform',
    valueType: SettingValueType.STRING,
    category: SettingCategory.GENERAL,
    description: 'Platform display name',
    displayName: 'Platform Name',
    isPublic: true,
  },
  {
    key: 'platform.version',
    value: '1.0.0',
    valueType: SettingValueType.STRING,
    category: SettingCategory.GENERAL,
    description: 'Current platform version',
    displayName: 'Platform Version',
    isPublic: true,
    isReadOnly: true,
  },
  {
    key: 'platform.environment',
    value: 'production',
    valueType: SettingValueType.STRING,
    category: SettingCategory.GENERAL,
    description: 'Deployment environment',
    displayName: 'Environment',
    isReadOnly: true,
  },
  {
    key: 'platform.timezone',
    value: 'UTC',
    valueType: SettingValueType.STRING,
    category: SettingCategory.GENERAL,
    description: 'Default timezone',
    displayName: 'Default Timezone',
  },
  {
    key: 'platform.locale',
    value: 'en-US',
    valueType: SettingValueType.STRING,
    category: SettingCategory.GENERAL,
    description: 'Default locale',
    displayName: 'Default Locale',
  },

  // Security Settings
  {
    key: 'security.session_timeout_minutes',
    value: '480',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.SECURITY,
    description: 'Session timeout in minutes',
    displayName: 'Session Timeout (minutes)',
  },
  {
    key: 'security.max_login_attempts',
    value: '5',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.SECURITY,
    description: 'Maximum login attempts before lockout',
    displayName: 'Max Login Attempts',
  },
  {
    key: 'security.lockout_duration_minutes',
    value: '30',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.SECURITY,
    description: 'Account lockout duration in minutes',
    displayName: 'Lockout Duration (minutes)',
  },
  {
    key: 'security.password_min_length',
    value: '8',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.SECURITY,
    description: 'Minimum password length',
    displayName: 'Password Min Length',
  },
  {
    key: 'security.mfa_enabled',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    category: SettingCategory.SECURITY,
    description: 'Enable MFA support platform-wide',
    displayName: 'MFA Enabled',
  },
  {
    key: 'security.enforce_https',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    category: SettingCategory.SECURITY,
    description: 'Force HTTPS connections',
    displayName: 'Enforce HTTPS',
  },

  // Email Settings
  {
    key: 'email.smtp_host',
    value: '',
    valueType: SettingValueType.STRING,
    category: SettingCategory.EMAIL,
    description: 'SMTP server hostname',
    displayName: 'SMTP Host',
  },
  {
    key: 'email.smtp_port',
    value: '587',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.EMAIL,
    description: 'SMTP server port',
    displayName: 'SMTP Port',
  },
  {
    key: 'email.smtp_secure',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    category: SettingCategory.EMAIL,
    description: 'Use TLS for SMTP',
    displayName: 'SMTP Secure',
  },
  {
    key: 'email.smtp_username',
    value: '',
    valueType: SettingValueType.STRING,
    category: SettingCategory.EMAIL,
    description: 'SMTP username',
    displayName: 'SMTP Username',
  },
  {
    key: 'email.smtp_password',
    value: '',
    valueType: SettingValueType.ENCRYPTED,
    category: SettingCategory.EMAIL,
    description: 'SMTP password (encrypted)',
    displayName: 'SMTP Password',
  },
  {
    key: 'email.from_address',
    value: 'noreply@aquaculture.io',
    valueType: SettingValueType.STRING,
    category: SettingCategory.EMAIL,
    description: 'Default from email address',
    displayName: 'From Address',
  },
  {
    key: 'email.from_name',
    value: 'Aquaculture Platform',
    valueType: SettingValueType.STRING,
    category: SettingCategory.EMAIL,
    description: 'Default from name',
    displayName: 'From Name',
  },

  // Rate Limit Settings
  {
    key: 'rate_limit.global_rpm',
    value: '1000',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.RATE_LIMIT,
    description: 'Global requests per minute',
    displayName: 'Global Rate Limit (RPM)',
  },
  {
    key: 'rate_limit.per_user_rpm',
    value: '100',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.RATE_LIMIT,
    description: 'Per-user requests per minute',
    displayName: 'Per User Rate Limit (RPM)',
  },
  {
    key: 'rate_limit.per_tenant_rpm',
    value: '500',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.RATE_LIMIT,
    description: 'Per-tenant requests per minute',
    displayName: 'Per Tenant Rate Limit (RPM)',
  },
  {
    key: 'rate_limit.api_key_rpm',
    value: '60',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.RATE_LIMIT,
    description: 'API key requests per minute',
    displayName: 'API Key Rate Limit (RPM)',
  },

  // Storage Settings
  {
    key: 'storage.provider',
    value: 'minio',
    valueType: SettingValueType.STRING,
    category: SettingCategory.STORAGE,
    description: 'Storage provider (minio, s3, azure)',
    displayName: 'Storage Provider',
    requiresRestart: true,
  },
  {
    key: 'storage.max_file_size_mb',
    value: '100',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.STORAGE,
    description: 'Maximum file upload size in MB',
    displayName: 'Max File Size (MB)',
  },
  {
    key: 'storage.allowed_extensions',
    value: '["pdf","doc","docx","xls","xlsx","csv","jpg","jpeg","png","gif","mp4"]',
    valueType: SettingValueType.JSON,
    category: SettingCategory.STORAGE,
    description: 'Allowed file extensions',
    displayName: 'Allowed Extensions',
  },

  // Maintenance Settings
  {
    key: 'maintenance.mode_enabled',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    category: SettingCategory.MAINTENANCE,
    description: 'Enable maintenance mode',
    displayName: 'Maintenance Mode',
  },
  {
    key: 'maintenance.message',
    value: 'System is under maintenance. Please try again later.',
    valueType: SettingValueType.STRING,
    category: SettingCategory.MAINTENANCE,
    description: 'Maintenance message shown to users',
    displayName: 'Maintenance Message',
  },
  {
    key: 'maintenance.allowed_ips',
    value: '[]',
    valueType: SettingValueType.JSON,
    category: SettingCategory.MAINTENANCE,
    description: 'IPs allowed during maintenance',
    displayName: 'Allowed IPs',
  },

  // Billing Settings
  {
    key: 'billing.stripe_enabled',
    value: 'false',
    valueType: SettingValueType.BOOLEAN,
    category: SettingCategory.BILLING,
    description: 'Enable Stripe payments',
    displayName: 'Stripe Enabled',
  },
  {
    key: 'billing.default_currency',
    value: 'USD',
    valueType: SettingValueType.STRING,
    category: SettingCategory.BILLING,
    description: 'Default currency for billing',
    displayName: 'Default Currency',
  },
  {
    key: 'billing.tax_rate',
    value: '0',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.BILLING,
    description: 'Default tax rate percentage',
    displayName: 'Default Tax Rate (%)',
  },
  {
    key: 'billing.invoice_due_days',
    value: '30',
    valueType: SettingValueType.NUMBER,
    category: SettingCategory.BILLING,
    description: 'Days until invoice is due',
    displayName: 'Invoice Due Days',
  },

  // Feature Flags
  {
    key: 'feature.swagger_enabled',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    category: SettingCategory.FEATURE_FLAG,
    description: 'Enable Swagger API documentation',
    displayName: 'Swagger Enabled',
  },
  {
    key: 'feature.graphql_playground',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    category: SettingCategory.FEATURE_FLAG,
    description: 'Enable GraphQL Playground',
    displayName: 'GraphQL Playground',
  },
  {
    key: 'feature.registration_enabled',
    value: 'true',
    valueType: SettingValueType.BOOLEAN,
    category: SettingCategory.FEATURE_FLAG,
    description: 'Allow new user registration',
    displayName: 'Registration Enabled',
  },
];
