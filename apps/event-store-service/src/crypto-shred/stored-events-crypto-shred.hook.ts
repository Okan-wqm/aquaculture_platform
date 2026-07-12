import type { TenantErasurePostErasureHook } from '@aquaculture/backend-common/compliance';
import { Injectable, Logger } from '@nestjs/common';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';

import { TenantPayloadCryptoService } from './tenant-payload-crypto.service';

/**
 * GDPR erasure treatment for the immutable `stored_events` log (rollout step 2
 * of docs/plans/2026-07-12-event-store-crypto-shred-design.md).
 *
 * `stored_events` is excluded from row deletion (append-only event-sourcing
 * ledger — deleting rows corrupts replay), so its Art-17 erasure is the
 * crypto-shred: destroy the tenant's payload DEK and every payload encrypted
 * under it becomes permanently unrecoverable. Runs as a post-erasure hook so a
 * shred failure fails the whole erasure (fail-closed — no success proof) and a
 * retry after a successful shred converges (shred is idempotent).
 */
@Injectable()
export class StoredEventsCryptoShredHook implements TenantErasurePostErasureHook {
  readonly hookName = 'stored-events-crypto-shred';
  private readonly logger = new Logger(StoredEventsCryptoShredHook.name);

  constructor(private readonly payloadCrypto: TenantPayloadCryptoService) {}

  async onTenantErased(event: TenantErasureRequestedEvent): Promise<void> {
    await this.payloadCrypto.shred(event.tenantId);
    this.logger.log(
      `stored_events crypto-shred completed for tenant=${event.tenantId} operation=${event.operationId}`,
    );
  }
}
