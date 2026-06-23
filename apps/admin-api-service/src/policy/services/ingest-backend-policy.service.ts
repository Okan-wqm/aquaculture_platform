import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OptimisticLockVersionMismatchError, Repository } from 'typeorm';

import { NatsEventBus } from '@platform/event-bus';
import {
  createBaseEvent,
  INGEST_BACKEND_POLICY_SUBJECTS,
  IngestBackendKind,
  IngestBackendPolicyChange,
  IngestBackendPolicyChangedEvent,
  IngestBackendSnapshot,
  validateIngestBackendPolicyEvent,
} from '@platform/event-contracts';

import {
  IngestBackendPolicyStateEntity,
  POLICY_STATE_SINGLETON_KEY,
  toSnapshot,
} from '../entities/ingest-backend-policy-state.entity';

/**
 * ADR-031 rollout-policy service. Owns:
 *   - reading the singleton SoT row;
 *   - applying an [[IngestBackendPolicyChange]] atomically
 *     (optimistic locking);
 *   - publishing the `policy.ingest_backend.changed` event on
 *     every successful mutation so the Rust sidecar hot-swaps
 *     without a restart.
 *
 * Tenancy: this service is platform-wide (admin domain). The
 * published event carries `tenantId: 'admin'` — the sidecar's
 * subscriber routes by subject, not by tenant claim.
 */
@Injectable()
export class IngestBackendPolicyService {
  private readonly logger = new Logger(IngestBackendPolicyService.name);

  constructor(
    @InjectRepository(IngestBackendPolicyStateEntity)
    private readonly repo: Repository<IngestBackendPolicyStateEntity>,
    private readonly eventBus: NatsEventBus,
  ) {}

  /**
   * Read the current authoritative snapshot. Called by
   * [[PolicySnapshotResponder]] on every
   * `policy.ingest_backend.snapshot` request-reply.
   *
   * Throws `NotFoundException` when the row is missing — the
   * migration seeds the default on boot, so a missing row means
   * the seed was rolled back manually and ops MUST restore
   * before the sidecar can cold-start.
   */
  async getSnapshot(): Promise<IngestBackendSnapshot> {
    const row = await this.findCurrent();
    return toSnapshot(row);
  }

  /**
   * Apply an incremental [[IngestBackendPolicyChange]]:
   *   1. Re-read the current row inside the same logical
   *      transaction to compute `next`.
   *   2. Optimistic-lock save (TypeORM @VersionColumn).
   *   3. Publish the `IngestBackendPolicyChangedEvent` on
   *      `policy.ingest_backend.changed` so the Rust sidecar's
   *      subscriber applies the same change to its in-memory
   *      ArcSwap + persists to disk.
   *
   * Throws:
   *   - `NotFoundException` when the singleton row has been
   *     manually deleted (ops error; the migration seeded it).
   *   - `ConflictException` on a concurrent modification that
   *     lost the optimistic-lock race. The caller should
   *     retry with fresh state.
   */
  async applyChange(
    change: IngestBackendPolicyChange,
    actorId?: string,
    reason?: string,
  ): Promise<IngestBackendSnapshot> {
    // Validate the would-be event payload BEFORE any side effect.
    // TS compile-time narrowing handles the happy path at the
    // callsite; this runtime guard catches untrusted inputs that
    // reached this service through a future HTTP surface or an
    // `as any` bypass. Failing here keeps the DB state from
    // drifting away from the NATS event stream — if we cannot
    // publish a valid event, we MUST NOT persist the row either.
    this.assertChangePayloadValid(change, actorId, reason);

    const current = await this.findCurrent();
    const next = applyChangeToRow(current, change);

    try {
      await this.repo.save(next);
    } catch (e) {
      if (e instanceof OptimisticLockVersionMismatchError) {
        throw new ConflictException(
          'ingest-backend policy was modified concurrently; re-read and retry',
        );
      }
      throw e;
    }

    // Persistence succeeded — the event is load-bearing for
    // cross-service consistency but NOT for correctness here
    // (the sidecar's next cold boot will read the same row via
    // the snapshot responder). A publish failure therefore
    // DOES NOT roll back the DB write; we log at WARN so
    // operators see the degraded state and investigate.
    await this.publishChangedEvent(change, actorId, reason);

    return toSnapshot(next);
  }

  /**
   * Defense-in-depth pre-flight: construct the event shape the
   * publisher would emit + validate it against the ADR-031 JSON
   * Schema. Throws `InternalServerErrorException` on schema
   * failure so the caller receives a structured 500 (never a
   * masked 200 that persisted silently).
   *
   * WHY extracted into its own helper: keeps `applyChange` scoped
   * to the orchestration steps; exposes the validation concern
   * so test coverage against `validateIngestBackendPolicyEvent`
   * lives on this method without drilling through the orchestrator.
   */
  private assertChangePayloadValid(
    change: IngestBackendPolicyChange,
    actorId: string | undefined,
    reason: string | undefined,
  ): void {
    const probe: IngestBackendPolicyChangedEvent = {
      ...createBaseEvent<IngestBackendPolicyChangedEvent>(
        'IngestBackendPolicyChanged',
        'admin',
      ),
      eventType: 'IngestBackendPolicyChanged',
      change,
      reason,
      actorId,
    };
    const validation = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      probe,
    );
    if (!validation.valid) {
      throw new InternalServerErrorException(
        `IngestBackendPolicyChanged payload failed schema validation: ${validation.errors}`,
      );
    }
  }

  private async findCurrent(): Promise<IngestBackendPolicyStateEntity> {
    const row = await this.repo.findOne({
      where: { key: POLICY_STATE_SINGLETON_KEY },
    });
    if (row === null) {
      // The migration seeds this row; the only path to missing
      // is an operator deleting it out-of-band. Surface loudly
      // so the sidecar's cold-start request receives a clear
      // 404-shaped remote error rather than hanging.
      throw new NotFoundException(
        `ingest-backend policy singleton row (key='${POLICY_STATE_SINGLETON_KEY}') not found`,
      );
    }
    return row;
  }

  private async publishChangedEvent(
    change: IngestBackendPolicyChange,
    actorId?: string,
    reason?: string,
  ): Promise<void> {
    // createBaseEvent returns a shape whose `eventType` is the
    // generic T['eventType'] = literal. The object-spread below
    // widens the member type back to `string` on the
    // intermediate — narrow it back with the event-contract
    // factory's own literal. We build the event in one literal
    // so the full shape is structurally verified against the
    // interface at compile time.
    // Validation already ran in `assertChangePayloadValid` before
    // the DB save — by the time publishChangedEvent runs we know
    // the event shape conforms to the ADR-031 schema.
    const event: IngestBackendPolicyChangedEvent = {
      ...createBaseEvent<IngestBackendPolicyChangedEvent>(
        'IngestBackendPolicyChanged',
        'admin',
      ),
      eventType: 'IngestBackendPolicyChanged',
      change,
      reason,
      actorId,
    };
    // NATS v3 (@nats-io/*) removed StringCodec/JSONCodec. publishCore's
    // contract is `payload: Uint8Array`, so UTF-8-encode the JSON via the
    // standard TextEncoder — byte-identical wire to the v2 StringCodec().encode()
    // producer, with no dependency on the removed `nats` codec API.
    const payload = new TextEncoder().encode(JSON.stringify(event));

    try {
      await this.eventBus.publishCore(
        INGEST_BACKEND_POLICY_SUBJECTS.changed,
        payload,
      );
      this.logger.log(
        `published ${INGEST_BACKEND_POLICY_SUBJECTS.changed} action=${change.action}`,
      );
    } catch (e) {
      // Publish failures are NOT rolled back (see applyChange
      // comment). Log so dashboards show the degraded state;
      // the sidecar's cold-start snapshot responder path
      // restores consistency on its next boot.
      this.logger.warn(
        `failed to publish ${INGEST_BACKEND_POLICY_SUBJECTS.changed} (state persisted, sidecar will learn on next cold-start): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

/**
 * Pure function — applies an incremental change to the entity
 * shape. Extracted out of the service so the state-transition
 * semantics are unit-testable without a DB + without a NATS
 * broker. Matches the Rust
 * `DynamicBackendPolicy::apply_change` transition table
 * byte-for-byte.
 */
export function applyChangeToRow(
  current: IngestBackendPolicyStateEntity,
  change: IngestBackendPolicyChange,
): IngestBackendPolicyStateEntity {
  // Shallow-clone so the caller's reference to `current` keeps
  // its original fields if the save fails. TypeORM's save()
  // relies on the @VersionColumn value being the one we READ,
  // so we copy it onto `next` verbatim.
  const next = Object.assign(new IngestBackendPolicyStateEntity(), current);
  // deep-copy overrides so mutations below don't leak into the
  // original reference.
  next.overrides = { ...current.overrides };

  switch (change.action) {
    case 'set_global':
      next.defaultBackend = change.backend;
      break;
    case 'set_tenant':
      assertKnownBackend(change.backend);
      next.overrides[change.tenantId] = change.backend;
      break;
    case 'remove_tenant': {
      // Rebuild the overrides map without the target key. A `delete` on a
      // dynamically-computed key is banned (no-dynamic-delete); reconstructing
      // the plain object preserves the exact JSONB persistence shape TypeORM
      // serializes (a bare object minus that key) without mutating-by-delete.
      const { [change.tenantId]: _removed, ...remaining } = next.overrides;
      next.overrides = remaining;
      break;
    }
    default: {
      // Exhaustiveness guard — a new action variant added on
      // the contract side MUST update this switch. The `never`
      // cast turns the drift into a build failure.
      const _exhaustive: never = change;
      throw new InternalServerErrorException(
        `unhandled IngestBackendPolicyChange action: ${JSON.stringify(
          _exhaustive,
        )}`,
      );
    }
  }
  return next;
}

function assertKnownBackend(backend: IngestBackendKind): void {
  if (backend !== 'node' && backend !== 'rust') {
    // Type system already guards the happy path; runtime guard
    // defends against callers that bypassed the typed contract.
    throw new InternalServerErrorException(
      `unknown IngestBackendKind: ${backend as string}`,
    );
  }
}
