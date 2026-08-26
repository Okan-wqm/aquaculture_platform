import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import {
  NatsRequestReply,
  RequestReplyContext,
  RequestReplyResponderHandle,
} from '@platform/event-bus';
import {
  INGEST_BACKEND_POLICY_SUBJECTS,
  IngestBackendSnapshot,
  IngestBackendSnapshotRequest,
} from '@platform/event-contracts';

import { IngestBackendPolicyService } from './ingest-backend-policy.service';

/**
 * Registers the ADR-031 request-reply responder for
 * `policy.ingest_backend.snapshot` on module init. The Rust
 * sensor-ingestion sidecar calls into this responder at every
 * cold start via `nats_client::request_typed`; the reply is the
 * authoritative per-tenant rollout snapshot that seeds the
 * sidecar's [[DynamicBackendPolicy]].
 *
 * Lifecycle:
 *   - onModuleInit → subscribes + stores the drain handle.
 *   - onModuleDestroy → drains the subscription so a shutdown
 *     mid-request completes the in-flight reply before the
 *     broker connection closes.
 */
@Injectable()
export class PolicySnapshotResponder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolicySnapshotResponder.name);
  private handle: RequestReplyResponderHandle | null = null;

  constructor(
    private readonly requestReply: NatsRequestReply,
    private readonly policyService: IngestBackendPolicyService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.handle = await this.requestReply.respond<
      IngestBackendSnapshotRequest,
      IngestBackendSnapshot
    >(INGEST_BACKEND_POLICY_SUBJECTS.snapshot, (req, ctx) => this.handleSnapshotRequest(req, ctx));
    this.logger.log(`policy-snapshot responder online: ${INGEST_BACKEND_POLICY_SUBJECTS.snapshot}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.handle !== null) {
      await this.handle.drain();
      this.logger.log('policy-snapshot responder drained');
    }
  }

  /**
   * Public so unit tests can drive the handler directly without
   * a live NATS broker. The request object is empty by design
   * (ADR-031 — subject disambiguates intent; broker ACLs authorize callers).
   */
  async handleSnapshotRequest(
    _req: IngestBackendSnapshotRequest,
    _ctx: RequestReplyContext,
  ): Promise<IngestBackendSnapshot> {
    const snapshot = await this.policyService.getSnapshot();
    this.logger.debug(
      `policy.ingest_backend.snapshot requested; defaultBackend=${snapshot.defaultBackend} overrides=${
        Object.keys(snapshot.overrides).length
      }`,
    );
    return snapshot;
  }
}
