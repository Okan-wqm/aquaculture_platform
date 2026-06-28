import { ObjectType, Field, ID, OmitType } from '@nestjs/graphql';
import { WorkArea } from '../entities/work-area.entity';
import { CertificationType } from '../../training/entities/certification-type.entity';

/**
 * Slim projection of an Employee currently assigned to a work area via an
 * in-progress rotation. Intentionally exposes only the display-safe fields the
 * detail view needs — no PII (national ID, address, bank details). `avatarUrl`
 * is resolved from the employee photo reference when present.
 */
@ObjectType()
export class WorkAreaAssignedEmployee {
  @Field(() => ID)
  id!: string;

  @Field()
  firstName!: string;

  @Field()
  lastName!: string;

  @Field({ nullable: true })
  avatarUrl?: string;
}

/**
 * Single work-area read model returned by the `workArea(id)` query.
 *
 * Extends the persisted WorkArea entity but REPLACES the scalar
 * `requiredCertifications: [String]` (cert-type IDs) with the resolved
 * `CertificationType[]` objects the frontend detail view selects, and adds the
 * computed `currentAssignments` list (employees with an in-progress rotation in
 * this area). `OmitType` removes the scalar field so the resolved object field
 * can take its place without a GraphQL field-merge conflict.
 */
@ObjectType()
export class WorkAreaDetail extends OmitType(WorkArea, ['requiredCertifications'] as const) {
  @Field(() => [CertificationType], { nullable: true })
  requiredCertifications?: CertificationType[];

  @Field(() => [WorkAreaAssignedEmployee])
  currentAssignments!: WorkAreaAssignedEmployee[];
}
