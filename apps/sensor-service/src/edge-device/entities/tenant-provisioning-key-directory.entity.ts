import { Entity, Column, PrimaryColumn, Index, CreateDateColumn } from 'typeorm';

/**
 * Tenant Provisioning Key Directory (SENSOR-HIGH-175)
 *
 * Routes a presented tenant provisioning key to the tenant that owns it. The
 * self-register and tenant-installer endpoints are public: they have no tenant
 * until the key names one, and `tenant_provisioning_keys` is a per-tenant table
 * under FORCE RLS, so without a route the key could only be found by reading
 * every tenant — which the pooled UNION that used to do it could not (zero rows
 * under RLS) and which an unauthenticated endpoint must not do anyway.
 *
 * Narrow by design — only what routing needs:
 *  - `route_hash`: sha256("sensor-provisioning-key-route:" || sha256(rawKey)),
 *    a domain-separated hash of the at-rest digest. It is neither the key nor
 *    the digest stored in the tenant row, so this table adds no key material.
 *  - `key_id`, `tenant_id`: where the key row lives.
 * Whether the key is active, expired or at capacity is decided only by the
 * tenant row, read inside that tenant's boundary.
 *
 * Cross-tenant infrastructure table — listed in
 * MODULE_SCHEMAS['sensor'].infrastructureTables, NOT per-tenant cloned; carries
 * the FORCED tenant-isolation policy like `edge_device_directory`.
 */
@Entity({ name: 'tenant_provisioning_key_directory', schema: 'sensor' })
export class TenantProvisioningKeyDirectory {
  @PrimaryColumn({ type: 'varchar', name: 'route_hash', length: 64 })
  routeHash!: string;

  @Column({ type: 'uuid', name: 'key_id' })
  @Index('uq_tenant_provisioning_key_directory_key_id', { unique: true })
  keyId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index('idx_tenant_provisioning_key_directory_tenant_id')
  tenantId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
