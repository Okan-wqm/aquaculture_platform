import {
  runInTenantTransaction,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import {
  FEEDING_TENANT_TRANSACTION_MUTATION_IDS_V1,
  feedingMutationAuthorityV1,
} from '@aquaculture/feeding-contracts';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type QueryRunner } from 'typeorm';

export type FeedingTenantTransactionWork<T> = (
  queryRunner: QueryRunner,
  mutationSession: TenantMutationSession,
) => Promise<T>;

/**
 * The sole runtime provider for catalogued protocol-configuration transactions.
 * Handlers identify themselves by their CQRS symbol; the catalog resolves the
 * mutation identity, schema and boundary before a tenant transaction can open.
 */
@Injectable()
export class FeedingMutationTransactionAuthority implements OnApplicationBootstrap {
  readonly mutationIds = FEEDING_TENANT_TRANSACTION_MUTATION_IDS_V1;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onApplicationBootstrap(): void {
    for (const mutationId of this.mutationIds) {
      this.assertTenantTransactionAuthority(feedingMutationAuthorityV1(mutationId));
    }
  }

  execute<T>(
    commandHandler: string,
    tenantId: string,
    work: FeedingTenantTransactionWork<T>,
  ): Promise<T> {
    const matches = this.mutationIds
      .map((mutationId) => feedingMutationAuthorityV1(mutationId))
      .filter((authority) => authority.commandHandler === commandHandler);
    if (matches.length !== 1) {
      throw new Error(
        `Feeding transaction handler ${commandHandler} must resolve exactly one catalog authority; found ${matches.length}`,
      );
    }
    const authority = matches[0]!;
    this.assertTenantTransactionAuthority(authority);
    return runInTenantTransaction(this.dataSource, authority.transaction.schema, tenantId, work);
  }

  private assertTenantTransactionAuthority(
    authority: ReturnType<typeof feedingMutationAuthorityV1>,
  ): void {
    if (
      authority.transaction.boundary !== 'tenant_transaction' ||
      authority.transaction.provider !== FeedingMutationTransactionAuthority.name ||
      authority.transaction.method !== 'execute' ||
      authority.transaction.schema !== 'farm' ||
      authority.commandHandler === null
    ) {
      throw new Error(`Mutation ${authority.id} is not a tenant transaction authority`);
    }
  }
}
