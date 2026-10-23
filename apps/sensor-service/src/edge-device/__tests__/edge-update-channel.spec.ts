/**
 * The update channel's rules as the cloud reads them (ADR-048 DEC-2.12;
 * channels.json update_channel): the contract's own settlement vectors decide
 * every verdict, so the cloud's "this request is settled" and the agent's "prune
 * the spool entry" read one result the same way.
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

import { STATEMENT } from '../edge-contract';
import {
  inDeliveryWindow,
  isCarriedStatementType,
  reasonClassOf,
  reissueDecision,
  REQUEST_UPDATE_TYPES,
  resultKindOf,
  settleVerdict,
  settlingResult,
  UPDATE_CHANNEL,
} from '../edge-update-channel';

const UPDATE_DIR = resolve(
  __dirname,
  '../../../../../contracts/suderra-edge/v1/fixtures/update-channel',
);

interface Vector {
  readonly id: string;
  readonly statement: {
    readonly statement_type: string;
    readonly result_kind: string;
    readonly digest: string;
    readonly expires_at: string;
  };
  readonly results: ReadonlyArray<{
    readonly seq: number;
    readonly kind: string;
    readonly outcome: string;
    readonly reason?: string;
    readonly subject?: { readonly statement_digest?: { readonly sha256: string } };
  }>;
  readonly now: string;
  readonly expect: { readonly agent_prunes: boolean; readonly cloud: string };
}

const vectors = (
  JSON.parse(readFileSync(join(UPDATE_DIR, 'settlement-vectors.json'), 'utf8')) as {
    vectors: Vector[];
  }
).vectors;

describe("settleVerdict over the contract's settlement vectors", () => {
  it('there are vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(18);
  });

  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const verdict = settleVerdict(
      {
        resultKind: vector.statement.result_kind,
        digestSha256: vector.statement.digest,
        expiresAt: new Date(vector.statement.expires_at),
      },
      vector.results,
      new Date(vector.now),
    );
    expect(verdict).toBe(vector.expect.cloud);
  });

  it('a statement with no window of its own never lapses (trust-anchors)', () => {
    const subject = { resultKind: 'trust-anchors', digestSha256: 'a'.repeat(64), expiresAt: null };
    expect(settleVerdict(subject, [], new Date('2099-01-01T00:00:00Z'))).toBe('wait');
  });

  it('of two results naming one digest the lowest seq concludes the request', () => {
    const digest = 'b'.repeat(64);
    const named = { statement_digest: { sha256: digest } };
    const subject = { resultKind: 'edge-update', digestSha256: digest, expiresAt: null };
    const results = [
      { seq: 9, kind: 'edge-update', outcome: 'ok', subject: named },
      {
        seq: 7,
        kind: 'edge-update',
        outcome: 'rejected',
        reason: 'signature-invalid',
        subject: named,
      },
    ];
    expect(settlingResult(subject, results)?.seq).toBe(7);
    expect(settleVerdict(subject, results, new Date())).toBe('final');
  });

  it('an alarm or failure without a retryable reason is final, an unknown reason is final', () => {
    const digest = 'c'.repeat(64);
    const subject = { resultKind: 'os-update', digestSha256: digest, expiresAt: null };
    const named = { statement_digest: { sha256: digest } };
    const settle = (outcome: string, reason: string): string =>
      settleVerdict(
        subject,
        [{ seq: 1, kind: 'os-update', outcome, reason, subject: named }],
        new Date(),
      );
    expect(settle('alarm', 'firewall-load-failed')).toBe('final');
    expect(settle('failed', 'a-reason-nobody-defined')).toBe('final');
    expect(reasonClassOf('a-reason-nobody-defined')).toBe('final');
  });
});

describe("the channel constants are the contract's", () => {
  it('reads the bounds from channels.json', () => {
    expect(UPDATE_CHANNEL).toEqual({
      deliveryMarginSeconds: 600,
      maxWindowSeconds: 86400,
      maxStatementBytes: 65536,
      reissueMinIntervalSeconds: 900,
      campaignMaxSeconds: 604800,
      maxSiteBundleBytes: 16777216,
    });
  });

  it('request_update carries exactly the five statement types and each has a result kind', () => {
    expect([...REQUEST_UPDATE_TYPES].sort()).toEqual(
      [
        STATEMENT.edgeUpdate,
        STATEMENT.osUpdate,
        STATEMENT.siteConfig,
        STATEMENT.siteNetpolicy,
        STATEMENT.trustAnchors,
      ].sort(),
    );
    expect(REQUEST_UPDATE_TYPES.map(resultKindOf)).toEqual(
      REQUEST_UPDATE_TYPES.map((type) => type.slice('suderra.'.length, type.length - '.v1'.length)),
    );
    expect(isCarriedStatementType(STATEMENT.edgeRelease)).toBe(false);
    expect(isCarriedStatementType(STATEMENT.deviceLifecycle)).toBe(false);
  });

  it('classifies each reason in exactly one class', () => {
    expect(reasonClassOf('maintenance-blocked')).toBe('retryable');
    expect(reasonClassOf('clock-unsynced')).toBe('retryable');
    expect(reasonClassOf('approval-missing')).toBe('reschedule');
    expect(reasonClassOf('expired')).toBe('reschedule');
    expect(reasonClassOf('sequence-replay')).toBe('final');
  });
});

describe('re-issue and delivery windows', () => {
  const start = new Date('2026-10-20T12:00:00Z');
  const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1000);

  it('a retryable refusal is re-issued no earlier than 900 s after it, and never after 7 days', () => {
    expect(reissueDecision(start, at(100), at(999))).toBe('too-early');
    expect(reissueDecision(start, at(100), at(1000))).toBe('allowed');
    expect(reissueDecision(start, at(100), at(604799))).toBe('allowed');
    expect(reissueDecision(start, at(100), at(604800))).toBe('campaign-over');
  });

  it('delivers a statement only inside its window with 600 s left', () => {
    const notBefore = at(0);
    const expiresAt = at(7200);
    expect(inDeliveryWindow(notBefore, expiresAt, at(-1))).toBe(false);
    expect(inDeliveryWindow(notBefore, expiresAt, at(0))).toBe(true);
    expect(inDeliveryWindow(notBefore, expiresAt, at(6599))).toBe(true);
    expect(inDeliveryWindow(notBefore, expiresAt, at(6600))).toBe(false);
    expect(inDeliveryWindow(notBefore, expiresAt, at(7200))).toBe(false);
  });
});
