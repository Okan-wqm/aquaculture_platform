import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MARINE_WORKER_CONTROL_SUBJECTS,
  MARINE_WORKER_SCOPED_INBOX_PREFIX,
  PLATFORM_EVENT_REGISTRY,
  type MarineWorkerControlContracts,
} from '../index';

describe('marine contract routing', () => {
  it('pins the exact Core NATS request subjects and scoped inbox prefix', () => {
    expect(MARINE_WORKER_CONTROL_SUBJECTS).toEqual({
      EXECUTION_LEASE: 'request.farm.marineExecutionLease',
      EXECUTION_RENEW: 'request.farm.marineExecutionRenew',
      CREDENTIAL_LEASE: 'request.farm.marineCredentialLease',
      USAGE_RESERVE: 'request.farm.marineUsageReserve',
      USAGE_FINALIZE: 'request.farm.marineUsageFinalize',
      ARTIFACT_LEASE: 'request.farm.marineArtifactLease',
      EXECUTION_FINALIZE: 'request.farm.marineExecutionFinalize',
    });
    expect(MARINE_WORKER_SCOPED_INBOX_PREFIX).toBe('_INBOXMARINEANALYSIS');
  });

  it('registers the durable event with its canonical subject and real fixture', () => {
    const entry = PLATFORM_EVENT_REGISTRY.MarineAnalysisRequested;
    expect(entry.subject).toBe('events.{tenantId}.MarineAnalysisRequested');
    expect(entry.producer).toBe('farm-service');
    expect(entry.consumers).toEqual(['marine-analysis-worker']);
    expect(entry.durability).toBe('outbox');
    expect(entry.piiClass).toBe('operational');
    expect(entry.acl).toEqual({ publish: ['farm-service'], subscribe: [] });
    expect(entry.jetStreamConsumer).toEqual({
      service: 'marine-analysis-worker',
      stream: 'AQUACULTURE_EVENTS',
      durable: 'marine-analysis-worker-v1',
      filterSubject: 'events.*.MarineAnalysisRequested',
      provisioning: 'INFRASTRUCTURE',
    });
    expect(entry.schema).toBe(
      'libs/event-contracts/src/marine-events.ts#MarineAnalysisRequestedEvent',
    );
    expect(existsSync(resolve(process.cwd(), entry.fixture))).toBe(true);
  });

  it('maps every subject to a distinct request and reply type', () => {
    type ExecutionRequest =
      MarineWorkerControlContracts[typeof MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE]['request'];
    type CredentialReply =
      MarineWorkerControlContracts[typeof MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE]['reply'];

    const request: ExecutionRequest = {
      tenantId: 'tenant',
      jobId: 'job',
      executionId: 'execution',
      nonce: 'nonce',
      requestFingerprint: 'fingerprint',
      requestedAt: '2026-07-19T12:00:00.000Z',
    };
    const reply: CredentialReply = {
      leaseId: 'lease',
      kind: 'CMEMS_USERNAME_PASSWORD',
      value: { username: 'fixture-user', password: 'fixture-value' },
      issuedAt: '2026-07-19T12:00:00.000Z',
      expiresAt: '2026-07-19T12:01:00.000Z',
      generation: 1,
    };

    expect(request.jobId).toBe('job');
    expect(reply.kind).toBe('CMEMS_USERNAME_PASSWORD');
  });
});
