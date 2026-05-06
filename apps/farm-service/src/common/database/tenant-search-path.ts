import { BadRequestException } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import {
  getTenantSchemaName,
  isValidUUID,
} from '@aquaculture/backend-common/database';

/**
 * Pin a manually-created QueryRunner to the current tenant schema.
 *
 * TenantConnectionBootstrap handles ordinary pool checkouts, but handlers that
 * create their own QueryRunner must set search_path inside the transaction
 * before using TypeORM metadata. Otherwise tenant-owned entities fall back to
 * the source schema and SourceSchemaWriteGuard blocks writes.
 */
export async function setTenantSearchPath(
  queryRunner: QueryRunner,
  tenantId: string,
): Promise<void> {
  if (!isValidUUID(tenantId)) {
    throw new BadRequestException(`Invalid tenantId format: ${tenantId}`);
  }

  const tenantSchema = getTenantSchemaName(tenantId);
  await queryRunner.query(
    `SET LOCAL search_path TO "${tenantSchema}", farm, public`,
  );
}
