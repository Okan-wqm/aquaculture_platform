import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** What changed a parameter's declared quantity. */
export enum ParameterQuantityDeclarationReason {
  /** An operator declared a quantity. */
  DECLARED = 'declared',
  /** An operator cleared the declaration; the code's own meaning stands. */
  CLEARED = 'cleared',
}

registerEnumType(ParameterQuantityDeclarationReason, {
  name: 'ParameterQuantityDeclarationReason',
});

/**
 * Append-only history of what a water-quality parameter was declared to
 * record (FARM-MEDIUM-374).
 *
 * A declaration reinterprets every value of the parameter — `ammonia` read as
 * NH3-N or as TAN differs ten- to a hundredfold — so who changed it, when, from
 * which code and unit, must be on record after the audit log is purged. The
 * config's `declaredQuantity` is the current state; this is its history,
 * written in the same transaction by the declare/clear commands, as sensor's
 * channel_quantity_declarations is for channels.
 *
 * Per-tenant table (no `schema:`), cloned into every tenant schema
 * (MODULE_SCHEMAS farm tables).
 */
@ObjectType({ description: 'Immutable record of one change to a parameter’s declared quantity' })
@Entity('parameter_quantity_declarations')
@Index('IDX_pqd_tenant_config_declared_at', ['tenantId', 'parameterConfigId', 'declaredAt'])
@Check('CHK_pqd_reason', `"reason" IN ('declared', 'cleared')`)
export class ParameterQuantityDeclaration {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  tenantId!: string;

  @Field(() => ID)
  @Column('uuid')
  parameterConfigId!: string;

  /** The parameter's code as of this change. */
  @Field()
  @Column({ type: 'varchar', length: 50 })
  code!: string;

  /** The declared quantity id; null when the declaration was cleared. */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 32, nullable: true })
  quantity!: string | null;

  /** The parameter's unit as of this change. */
  @Field()
  @Column({ type: 'varchar', length: 30 })
  unit!: string;

  @Field(() => ParameterQuantityDeclarationReason)
  @Column({ type: 'varchar', length: 32 })
  reason!: ParameterQuantityDeclarationReason;

  @Field()
  @Column({ type: 'varchar', length: 255 })
  declaredBy!: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  declaredAt!: Date;
}
