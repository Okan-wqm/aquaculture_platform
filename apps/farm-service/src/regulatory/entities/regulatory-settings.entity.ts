/**
 * Regulatory Settings Entity
 *
 * Stores company information and Maskinporten OAuth2 credentials per tenant.
 *
 * SECURITY: Maskinporten secret columns (client_id, private_key) are encrypted
 * at rest with the canonical authenticated AES-256-GCM column transformer
 * (createEncryptedColumnTransformer). GCM provides confidentiality AND integrity
 * (auth tag) — replacing the previous bespoke unauthenticated AES-256-CBC scheme
 * that was vulnerable to ciphertext malleability and the padding-oracle class.
 * The ORM encrypts on write and decrypts on read, so the service layer never
 * touches ciphertext.
 * @see HIGH sentinel-cbc
 *
 * This entity is stored in tenant schemas (schema-level isolation):
 * - tenant_4b529829.regulatory_settings
 * - tenant_abc12345.regulatory_settings
 * etc.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { createEncryptedColumnTransformer } from '@aquaculture/backend-common/security';

/**
 * Site to Lokalitetsnummer mapping for Mattilsynet reports
 */
export interface SiteLocalityMapping {
  siteId: string;
  lokalitetsnummer: number;
  siteName?: string;
}

/**
 * Company address structure
 */
export interface CompanyAddress {
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
}

@ObjectType()
@Entity('regulatory_settings')
@Index(['tenantId'], { unique: true })
export class RegulatorySettings {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId: string;

  // ==========================================================================
  // Company Information
  // ==========================================================================

  @Field({ nullable: true })
  @Column({ name: 'company_name', length: 255, nullable: true })
  companyName?: string;

  @Field({ nullable: true })
  @Column({ name: 'organisation_number', length: 20, nullable: true })
  organisationNumber?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'company_address', type: 'jsonb', nullable: true })
  companyAddress?: CompanyAddress;

  // ==========================================================================
  // Maskinporten OAuth2 Credentials (ENCRYPTED - NOT exposed via GraphQL)
  // ==========================================================================

  /** Maskinporten Client ID (AES-256-GCM encrypted at rest; transparent on read/write) */
  @Column({
    name: 'maskinporten_client_id',
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer('REGULATORY_ENCRYPTION_KEY'),
  })
  maskinportenClientId?: string;

  /** Maskinporten Private Key in PEM format (AES-256-GCM encrypted at rest; transparent on read/write) */
  @Column({
    name: 'maskinporten_private_key_encrypted',
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer('REGULATORY_ENCRYPTION_KEY'),
  })
  maskinportenPrivateKeyEncrypted?: string;

  /** Maskinporten Key ID (kid) for JWT header */
  @Column({ name: 'maskinporten_key_id', length: 100, nullable: true })
  maskinportenKeyId?: string;

  /** Maskinporten environment: 'TEST' or 'PRODUCTION' */
  @Field({ nullable: true })
  @Column({ name: 'maskinporten_environment', length: 20, default: 'TEST' })
  maskinportenEnvironment: string;

  // ==========================================================================
  // Default Contact for Reports
  // ==========================================================================

  @Field({ nullable: true })
  @Column({ name: 'default_contact_name', length: 255, nullable: true })
  defaultContactName?: string;

  @Field({ nullable: true })
  @Column({ name: 'default_contact_email', length: 255, nullable: true })
  defaultContactEmail?: string;

  @Field({ nullable: true })
  @Column({ name: 'default_contact_phone', length: 50, nullable: true })
  defaultContactPhone?: string;

  // ==========================================================================
  // Site to Lokalitetsnummer Mappings (for Mattilsynet reports)
  // ==========================================================================

  /** Mapping of Site ID to Lokalitetsnummer (e.g., { "site-uuid": 12345 }) */
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'site_locality_mappings', type: 'jsonb', default: '{}' })
  siteLocalityMappings: Record<string, number>;

  // Slaughter approval number moved to the slaughter_facilities catalog
  // (SSoT — CreateSlaughterFacilities1803450000000); the legacy
  // regulatory_settings.slaughter_approval_number column is dropped by
  // DropRegulatorySettingsSlaughterApprovalNumber1804100000000 (Phase 4 dedup).

  // ==========================================================================
  // Automated submission (opt-in per report type — user decision, RPT-003)
  // ==========================================================================

  /**
   * Per-report-type auto-submit opt-in, keyed by ReportPrefillType value, e.g.
   * `{ "SEA_LICE": true }`. Absent/false → the scheduler assembles the draft
   * but leaves submission to operator approval.
   */
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'auto_submit_policies', type: 'jsonb', default: '{}' })
  autoSubmitPolicies: Record<string, boolean>;

  // ==========================================================================
  // Metadata
  // ==========================================================================

  @Field()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
