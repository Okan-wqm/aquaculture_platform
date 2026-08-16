import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { computeFindingEventHash } from '../../libs/backend-common/src/finding-registry/finding-event';
import { buildBootstrapEvents, isCutoverReady } from '../../tools/gates/finding-event-ledger';

const ROOT = resolve(__dirname, '..', '..');
const migration = readFileSync(
  resolve(
    ROOT,
    'apps/event-store-service/src/migrations/1801200000000-CreateFindingEventsLedger.ts',
  ),
  'utf8',
);
const entity = readFileSync(
  resolve(ROOT, 'apps/event-store-service/src/finding-registry/finding-event.entity.ts'),
  'utf8',
);
const jsonlCli = readFileSync(resolve(ROOT, 'tools/gates/finding-registry.ts'), 'utf8');
const ledgerCli = readFileSync(resolve(ROOT, 'tools/gates/finding-event-ledger.ts'), 'utf8');

describe('finding event ledger contract', () => {
  it('creates the exact immutable event envelope and parity ledger', () => {
    for (const column of [
      'event_id',
      'finding_id',
      'version',
      'event_type',
      'payload',
      'main_sha',
      'occurred_at',
      'prev_hash',
      'content_hash',
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain('UNIQUE (finding_id, version)');
    expect(migration).toContain("['finding_events', 'finding_ledger_parity_runs']");
    expect(migration).toContain('CREATE TRIGGER ${table}_immutable');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('BEFORE TRUNCATE');
    expect(migration).toContain('finding_ledger_parity_runs');
  });

  it('maps the persistence entity to event_store.finding_events with an explicit schema', () => {
    expect(entity).toContain("@Entity({ name: 'finding_events', schema: 'event_store' })");
    expect(entity).toContain("name: 'finding_id'");
    expect(entity).toContain("name: 'event_type'");
    expect(entity).not.toContain("name: 'findings'");
    expect(entity.match(/@Check\(/g)).toHaveLength(5);
  });

  it('builds a deterministic bootstrap event chain from the JSONL authority', () => {
    const snapshot = {
      id: 'DATA-HIGH-009',
      severity: 'HIGH' as const,
      state: 'IN-PROGRESS' as const,
      title: 'Ledger gap',
      layer: 5 as const,
      owner_agent: 'data-expert',
      raised_in_cycle: 'cycle',
      review_file: 'docs/reviews/orphan-findings.md',
      evidence: ['a.ts'],
      rule_violated: 'immutable history',
      notes: 'evidence',
      narrative: ['Full audit context'],
      deadline: '2026-07-22',
      owner_user: null,
      override_of: null,
      closing_commits: [],
      created_at: '2026-07-17T00:00:00Z',
      closed_at: null,
      content_hash: 'c'.repeat(64),
    };
    const first = buildBootstrapEvents([snapshot], 'a'.repeat(40));
    const second = buildBootstrapEvents([snapshot], 'a'.repeat(40));

    expect(first).toEqual(second);
    expect(first[0]?.prev_hash).toBe('0'.repeat(64));
    expect(first[0]?.content_hash).toBe(computeFindingEventHash(first[0]!));
    expect(first[0]?.payload).toMatchObject({ layer: 5, narrative: ['Full audit context'] });
  });

  it('keeps JSONL authoritative until two recorded parity cycles pass', () => {
    expect(jsonlCli).toContain('const REGISTRY_PATH = resolve(REPO_ROOT, REGISTRY_RELATIVE_PATH)');
    expect(jsonlCli).not.toContain('event_store.finding_events');
    expect(ledgerCli).toContain('required_cycles: 2');
    expect(ledgerCli).toContain('isCutoverReady(expectedTip, replay.chain_tip');
    expect(ledgerCli).toContain('registryTipAtCommit(mainSha)');
    expect(ledgerCli).toContain("command === 'cutover-ready'");
    expect(ledgerCli).not.toContain('writeFileSync(REGISTRY_PATH');
  });

  it('rejects stale, failed, duplicate-SHA, and non-parity cutover evidence', () => {
    const registryTip = 'a'.repeat(64);
    const ledgerTip = 'b'.repeat(64);
    const cycles = [
      {
        passed: true,
        registry_tip_hash: registryTip,
        ledger_tip_hash: ledgerTip,
        main_sha: 'c'.repeat(40),
      },
      {
        passed: true,
        registry_tip_hash: registryTip,
        ledger_tip_hash: ledgerTip,
        main_sha: 'd'.repeat(40),
      },
    ];

    expect(isCutoverReady(registryTip, ledgerTip, [], cycles)).toBe(true);
    expect(isCutoverReady(registryTip, 'e'.repeat(64), [], cycles)).toBe(false);
    expect(isCutoverReady(registryTip, ledgerTip, ['projection drift'], cycles)).toBe(false);
    expect(isCutoverReady(registryTip, ledgerTip, [], [cycles[0]!])).toBe(false);
    expect(
      isCutoverReady(registryTip, ledgerTip, [], [cycles[0]!, { ...cycles[1]!, passed: false }]),
    ).toBe(false);
    expect(
      isCutoverReady(
        registryTip,
        ledgerTip,
        [],
        [cycles[0]!, { ...cycles[1]!, main_sha: cycles[0]!.main_sha }],
      ),
    ).toBe(false);
  });
});
