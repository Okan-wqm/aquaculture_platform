import type { Subscription } from '@nats-io/nats-core';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { CoreNatsConnectionSnapshot, NatsEventBus, NatsRequestReply } from '@platform/event-bus';
import { INGEST_BACKEND_POLICY_SUBJECTS, IngressOwnerPolicy } from '@platform/event-contracts';

export type NestjsOwnerDecision = 'PROCESS' | 'NOT_OWNER' | 'INDETERMINATE';

const OWNER_POLICY_SNAPSHOT_LEASE_MS = 5_000;
const OWNER_POLICY_RECONCILIATION_INTERVAL_MS = 2_000;

export class IngressOwnerPolicyRegistry {
  private policies: ReadonlyMap<string, IngressOwnerPolicy> = new Map();
  private lastAuthoritativeSnapshotAtMs = Date.now();

  replaceSnapshot(snapshot: readonly IngressOwnerPolicy[], observedAtMs = Date.now()): void {
    const replacement = new Map<string, IngressOwnerPolicy>();
    for (const policy of snapshot) {
      if (!isIngressOwnerPolicy(policy)) {
        throw new Error('owner-policy snapshot contains an invalid policy');
      }
      const existing = replacement.get(policy.tenantId);
      if (existing === undefined || policy.version > existing.version) {
        replacement.set(policy.tenantId, policy);
      }
    }
    this.policies = replacement;
    this.lastAuthoritativeSnapshotAtMs = observedAtMs;
  }

  mergeSnapshot(snapshot: readonly IngressOwnerPolicy[], observedAtMs = Date.now()): void {
    const replacement = new Map<string, IngressOwnerPolicy>();
    for (const policy of snapshot) {
      if (!isIngressOwnerPolicy(policy)) {
        throw new Error('owner-policy snapshot contains an invalid policy');
      }
      const existing = replacement.get(policy.tenantId);
      if (existing === undefined || policy.version > existing.version) {
        replacement.set(policy.tenantId, policy);
      }
    }
    for (const [tenantId, current] of this.policies) {
      const authoritative = replacement.get(tenantId);
      if (authoritative !== undefined && current.version > authoritative.version) {
        replacement.set(tenantId, current);
      }
    }
    this.policies = replacement;
    this.lastAuthoritativeSnapshotAtMs = observedAtMs;
  }

  apply(policy: IngressOwnerPolicy): boolean {
    if (!isIngressOwnerPolicy(policy)) return false;
    const current = this.policies.get(policy.tenantId);
    if (current !== undefined) {
      if (policy.version < current.version) return false;
      if (policy.version === current.version) {
        return policiesEqual(current, policy);
      }
    }
    const replacement = new Map(this.policies);
    replacement.set(policy.tenantId, policy);
    this.policies = replacement;
    return true;
  }

  decide(tenantId: string, nowMs = Date.now()): NestjsOwnerDecision {
    if (nowMs - this.lastAuthoritativeSnapshotAtMs > OWNER_POLICY_SNAPSHOT_LEASE_MS) {
      return 'INDETERMINATE';
    }
    const policy = this.policies.get(tenantId);
    if (policy === undefined || policy.state !== 'ACTIVE') return 'INDETERMINATE';
    return policy.owner === 'NESTJS' ? 'PROCESS' : 'NOT_OWNER';
  }
}

@Injectable()
export class IngressOwnerPolicyConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngressOwnerPolicyConsumerService.name);
  private readonly registry = new IngressOwnerPolicyRegistry();
  private subscription: Subscription | null = null;
  private activeGeneration = -1;
  private activation: Promise<void> = Promise.resolve();
  private reconciliation: Promise<void> = Promise.resolve();
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private removeLifecycleListener: (() => void) | null = null;
  private destroying = false;

  constructor(
    private readonly eventBus: NatsEventBus,
    private readonly requestReply: NatsRequestReply,
  ) {}

  onModuleInit(): void {
    this.removeLifecycleListener = this.eventBus.onCoreConnectionLifecycle((snapshot) => {
      this.activation = this.activation
        .then(() => this.activate(snapshot))
        .catch((error: unknown) => {
          this.registry.replaceSnapshot([]);
          this.logger.error(
            `owner-policy activation failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.destroying = true;
    this.stopReconciliation();
    this.removeLifecycleListener?.();
    this.removeLifecycleListener = null;
    await this.activation;
    await this.reconciliation;
    if (this.subscription !== null) {
      await this.subscription.drain();
      this.subscription = null;
    }
  }

  decide(tenantId: string): NestjsOwnerDecision {
    return this.registry.decide(tenantId);
  }

  private async activate(snapshot: CoreNatsConnectionSnapshot): Promise<void> {
    if (this.destroying) return;
    this.stopReconciliation();
    await this.reconciliation;
    if (snapshot.state !== 'connected' || snapshot.connection === null) {
      this.registry.replaceSnapshot([]);
      return;
    }
    if (snapshot.generation === this.activeGeneration) return;

    this.registry.replaceSnapshot([]);
    if (this.subscription !== null) {
      await this.subscription.drain();
      this.subscription = null;
    }

    const subscription = snapshot.connection.subscribe(
      INGEST_BACKEND_POLICY_SUBJECTS.ownerSubjectFilter,
    );
    try {
      const policies = await this.fetchSnapshot();
      this.registry.replaceSnapshot(policies);
      this.subscription = subscription;
      this.activeGeneration = snapshot.generation;
      void this.consume(subscription);
      this.startReconciliation(snapshot.generation);
    } catch (error) {
      await subscription.drain();
      throw error;
    }
  }

  private fetchSnapshot(): Promise<IngressOwnerPolicy[]> {
    return this.requestReply.requestTyped<Record<string, never>, IngressOwnerPolicy[]>(
      INGEST_BACKEND_POLICY_SUBJECTS.ownerSnapshot,
      {},
      { timeoutMs: 2_000 },
    );
  }

  private startReconciliation(generation: number): void {
    this.reconciliationTimer = setInterval(() => {
      this.reconciliation = this.reconciliation
        .then(async () => {
          if (this.destroying || generation !== this.activeGeneration) return;
          const policies = await this.fetchSnapshot();
          if (generation === this.activeGeneration) {
            this.registry.mergeSnapshot(policies);
          }
        })
        .catch((error: unknown) => {
          this.registry.replaceSnapshot([]);
          this.logger.error(
            `owner-policy reconciliation failed closed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }, OWNER_POLICY_RECONCILIATION_INTERVAL_MS);
    this.reconciliationTimer.unref();
  }

  private stopReconciliation(): void {
    if (this.reconciliationTimer !== null) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
  }

  private async consume(subscription: Subscription): Promise<void> {
    try {
      for await (const message of subscription) {
        const decoded: unknown = message.json<unknown>();
        if (!isIngressOwnerPolicy(decoded) || !this.registry.apply(decoded)) {
          this.logger.warn(`rejected stale or invalid owner-policy subject=${message.subject}`);
        }
      }
    } catch (error) {
      if (!this.destroying) {
        this.registry.replaceSnapshot([]);
        this.logger.error(
          `owner-policy subscription failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function isIngressOwnerPolicy(value: unknown): value is IngressOwnerPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const policy = value as Record<string, unknown>;
  return (
    typeof policy['tenantId'] === 'string' &&
    Number.isInteger(policy['version']) &&
    (policy['owner'] === 'NESTJS' || policy['owner'] === 'RUST') &&
    typeof policy['effectiveEpoch'] === 'string' &&
    Number.isFinite(Date.parse(policy['effectiveEpoch'])) &&
    (policy['state'] === 'PREPARING' ||
      policy['state'] === 'ACTIVE' ||
      policy['state'] === 'DRAINING')
  );
}

function policiesEqual(left: IngressOwnerPolicy, right: IngressOwnerPolicy): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.version === right.version &&
    left.owner === right.owner &&
    left.effectiveEpoch === right.effectiveEpoch &&
    left.state === right.state
  );
}
