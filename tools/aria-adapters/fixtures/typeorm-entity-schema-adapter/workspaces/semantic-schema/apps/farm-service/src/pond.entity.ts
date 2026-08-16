import { Entity, PrimaryGeneratedColumn } from 'typeorm';

// Semantic fixture known-FP trap (tenant_scoped_per_tenant_schema_omission):
// `ponds` is in MODULE_SCHEMAS['farm'].tables (per-tenant clone list) in the
// real SSoT (libs/backend-common/src/database/schema-manager.service.ts), so
// omitting `schema:` here is the CORRECT ADR-011 pattern — search_path routes
// the table into tenant_<uuid> at runtime. The adapter must NOT flag it.
@Entity('ponds')
export class Pond {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
}
