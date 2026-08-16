import { Baseline1800000000000 } from './1800000000000-Baseline';
import { CreateMessagingOutboxTable1800200000000 } from './1800200000000-CreateMessagingOutboxTable';
import { AddUserAiConsentTenantUserUnique1800300000000 } from './1800300000000-AddUserAiConsentTenantUserUnique';
import { EnforceSourceOnlyMessagingOutboxContract1800400000000 } from './1800400000000-EnforceSourceOnlyMessagingOutboxContract';
import { EnsureMessagingPartitionContract1800500000000 } from './1800500000000-EnsureMessagingPartitionContract';
import { CreateMessageSendIdempotencyLedger1800600000000 } from './1800600000000-CreateMessageSendIdempotencyLedger';
import { AddMessagesEmbeddingColumn1800700000000 } from './1800700000000-AddMessagesEmbeddingColumn';
import { CreateMessageReceiptLedger1800800000000 } from './1800800000000-CreateMessageReceiptLedger';
import { EnsureMessagingTenantErasureProofLedger1801000000000 } from './1801000000000-EnsureMessagingTenantErasureProofLedger';
import { DropChannelAiServiceUrl1802000000000 } from './1802000000000-DropChannelAiServiceUrl';
import { DropTenantAiSettings1802100000000 } from './1802100000000-DropTenantAiSettings';
import { CreateLegalHoldReleaseOperations1802200000000 } from './1802200000000-CreateLegalHoldReleaseOperations';

/**
 * Canonical runtime migration class list for messaging-service.
 *
 * The bundled service and the real-database E2E harness both project this
 * ordered list. Keeping class discovery here prevents a test-only migration
 * history from silently diverging from the runtime ledger.
 */
export const MESSAGING_MIGRATIONS = Object.freeze([
  Baseline1800000000000,
  CreateMessagingOutboxTable1800200000000,
  AddUserAiConsentTenantUserUnique1800300000000,
  EnforceSourceOnlyMessagingOutboxContract1800400000000,
  EnsureMessagingPartitionContract1800500000000,
  CreateMessageSendIdempotencyLedger1800600000000,
  AddMessagesEmbeddingColumn1800700000000,
  CreateMessageReceiptLedger1800800000000,
  EnsureMessagingTenantErasureProofLedger1801000000000,
  DropChannelAiServiceUrl1802000000000,
  DropTenantAiSettings1802100000000,
  CreateLegalHoldReleaseOperations1802200000000,
]);
