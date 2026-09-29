/**
 * FarmSignalIncidentService unit specs (FARM-LOW-144)
 *
 * The single owner of the "farm signal → AlertIncident" dedup + escalation
 * lifecycle, extracted from the near-verbatim copies that used to live in
 * MortalityAlertService and WaterQualityCriticalAlertService. Proves the
 * behaviour once, for any signal: bump the open incident for a (ruleId, tenant)
 * if one exists, else create a NEW incident and start escalation. Severity is
 * carried through from the caller's spec (mortality can be WARNING; water
 * quality is always CRITICAL) so the shared path never hard-codes it.
 *
 * London-school: the incident repository is a @platform/testing double and the
 * escalation manager is a typed double (only startEscalation is exercised).
 *
 * ALERT-CRITICAL-004/009: the identity is the branded signal key stored in
 * `signal_key` (rule_id stays NULL), escalation is AWAITED and level-triggered,
 * and a lost race on the open-incident unique index joins the winner.
 */
import { createMockRepository } from '@aquaculture/testing';
import { signalKey } from '@platform/event-contracts';
import { QueryFailedError } from 'typeorm';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import { AlertIncident, IncidentStatus } from '../../../database/entities/alert-incident.entity';
import { EscalationManagerService } from '../../../escalation/escalation-manager.service';
import { FarmSignalIncidentService, FarmSignalIncidentSpec } from '../farm-signal-incident.service';
import { IncidentEscalationFailedError } from '../incident-escalation-failed.error';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const KEY = signalKey({ kind: 'mortality', batchId: '33333333-3333-4333-8333-333333333333' });
const TRIGGERED_AT = new Date('2026-06-10T08:00:00.000Z');

function makeSpec(overrides: Partial<FarmSignalIncidentSpec> = {}): FarmSignalIncidentSpec {
  return {
    tenantId: TENANT_ID,
    signalKey: KEY,
    siteId: SITE_ID,
    title: 'High Mortality (cumulative_rate): batch b-1',
    description: 'Cumulative mortality rate 12.00% is critical',
    severity: AlertSeverity.CRITICAL,
    triggerData: { historyId: 'history-1', batchId: 'b-1' },
    triggeredAt: TRIGGERED_AT,
    signalLabel: 'mortality',
    ...overrides,
  };
}

/** An open incident as `findOpenIncident` returns it. */
function openIncident(severity: AlertSeverity, escalationLevel = 1): AlertIncident {
  const row = new AlertIncident();
  Object.assign(row, {
    id: 'incident-existing',
    occurrenceCount: 1,
    status: IncidentStatus.NEW,
    severity,
    escalationLevel,
    siteId: SITE_ID,
    description: 'opened seven days ago',
    triggerData: { historyId: 'history-1' },
    timeline: [],
  });
  return row;
}

/** Minimal EscalationManagerService double — only startEscalation is called. */
type EscalationDouble = jest.Mocked<Pick<EscalationManagerService, 'startEscalation'>>;

/**
 * The atomic UPDATE doubles (V-S1a-4). Every `createQueryBuilder()` returns a
 * fresh chain; `execute` answers in call order: the occurrence bump first (its
 * RETURNING row = the incident's CURRENT level/severity in the database), then
 * — only when the severity rose — the conditional severity rise (`affected`).
 */
interface UpdateScript {
  bumped: { escalation_level: number; severity: AlertSeverity };
  riseWins?: boolean;
}

function scriptedUpdates(script: UpdateScript): {
  createQueryBuilder: jest.Mock;
  chains: Array<Record<string, jest.Mock>>;
} {
  const results = [
    { raw: [script.bumped], affected: 1 },
    { raw: [], affected: script.riseWins === false ? 0 : 1 },
  ];
  const chains: Array<Record<string, jest.Mock>> = [];
  const createQueryBuilder = jest.fn(() => {
    const chain: Record<string, jest.Mock> = {};
    for (const step of [
      'update',
      'set',
      'where',
      'andWhere',
      'setParameter',
      'setParameters',
      'returning',
    ]) {
      chain[step] = jest.fn(() => chain);
    }
    const result = results[chains.length] ?? { raw: [], affected: 0 };
    chain['execute'] = jest.fn().mockResolvedValue(result);
    chains.push(chain);
    return chain;
  });
  return { createQueryBuilder, chains };
}

function makeService(
  opts: { existingIncident?: AlertIncident | null; updates?: UpdateScript } = {},
): {
  service: FarmSignalIncidentService;
  incidentRepo: jest.Mocked<import('typeorm').Repository<AlertIncident>>;
  escalation: EscalationDouble;
  chains: Array<Record<string, jest.Mock>>;
} {
  const incidentRepo = createMockRepository<AlertIncident>();
  incidentRepo.findOne.mockResolvedValue(opts.existingIncident ?? null);
  incidentRepo.create.mockImplementation((dto) => {
    const incident = new AlertIncident();
    Object.assign(incident, { id: 'incident-1', ...dto });
    return incident;
  });
  incidentRepo.save.mockImplementation(async (i) => i as AlertIncident);
  const updates = scriptedUpdates(
    opts.updates ?? { bumped: { escalation_level: 1, severity: AlertSeverity.CRITICAL } },
  );
  incidentRepo.createQueryBuilder.mockImplementation(updates.createQueryBuilder);

  const escalation: EscalationDouble = {
    startEscalation: jest.fn().mockResolvedValue('escalated'),
  };
  const service = new FarmSignalIncidentService(incidentRepo, escalation);
  return { service, incidentRepo, escalation, chains: updates.chains };
}

describe('FarmSignalIncidentService', () => {
  it('creates a NEW incident and starts its first escalation when none is open', async () => {
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });

    await service.ensureIncident(makeSpec());

    expect(incidentRepo.create).toHaveBeenCalledTimes(1);
    const created = incidentRepo.create.mock.calls[0]?.[0] as Partial<AlertIncident>;
    // ALERT-CRITICAL-009: the farm identity lives in signal_key; rule_id (FK) stays NULL.
    expect(created.ruleId).toBeNull();
    expect(created.signalKey).toBe(KEY);
    expect(created.siteId).toBe(SITE_ID);
    expect(created.severity).toBe(AlertSeverity.CRITICAL);
    expect(created.occurrenceCount).toBe(1);
    expect(created.lastOccurredAt).toBe(TRIGGERED_AT);

    expect(escalation.startEscalation).toHaveBeenCalledWith(expect.anything(), {
      severity: AlertSeverity.CRITICAL,
      matchKey: KEY,
    });
  });

  it('carries the caller severity through to the incident and escalation', async () => {
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });

    await service.ensureIncident(makeSpec({ severity: AlertSeverity.WARNING }));

    const created = incidentRepo.create.mock.calls[0]?.[0] as Partial<AlertIncident>;
    expect(created.severity).toBe(AlertSeverity.WARNING);
    expect(escalation.startEscalation.mock.calls[0]?.[1]).toMatchObject({
      severity: AlertSeverity.WARNING,
    });
  });

  it('bumps an open, escalated incident with ONE atomic UPDATE and pages nobody again', async () => {
    // SCENARIO: a repeat occurrence of an already-escalated condition.
    // EXPECTS: `occurrence_count + 1` in SQL (no full-entity save of a stale
    //          read), the site filled only if unknown, and no second page.
    const { service, incidentRepo, escalation, chains } = makeService({
      existingIncident: openIncident(AlertSeverity.CRITICAL),
    });

    await service.ensureIncident(makeSpec());

    expect(incidentRepo.save).not.toHaveBeenCalled();
    expect(incidentRepo.create).not.toHaveBeenCalled();
    expect(chains).toHaveLength(1);
    const set = chains[0]?.['set']?.mock.calls[0]?.[0] as Record<string, () => string>;
    expect(set['occurrenceCount']?.()).toBe('occurrence_count + 1');
    expect(set['siteId']?.()).toContain('COALESCE(site_id');
    // The row comes back from RETURNING (a property-path array would silently
    // select nothing — the real-Postgres spec proves the round trip).
    expect(chains[0]?.['returning']).toHaveBeenCalledWith('"escalation_level", "severity"');
    expect(chains[0]?.['setParameters']).toHaveBeenCalledWith({
      occurredAt: TRIGGERED_AT,
      siteId: SITE_ID,
    });
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  /**
   * W7 / FARM-MEDIUM-259 — dedup used to freeze an incident at the severity it
   * was FIRST opened with; a more severe occurrence now raises it and re-runs
   * the ladder. V-S1a-4: the rise is a conditional UPDATE only one delivery wins.
   */
  it('raises an open incident when a MORE severe occurrence wins the rise, and re-runs escalation', async () => {
    const existing = openIncident(AlertSeverity.WARNING);
    const { service, escalation, chains } = makeService({
      existingIncident: existing,
      updates: { bumped: { escalation_level: 1, severity: AlertSeverity.WARNING }, riseWins: true },
    });

    await service.ensureIncident(
      makeSpec({
        severity: AlertSeverity.CRITICAL,
        description: '2 days of cover remaining',
        triggerData: { historyId: 'history-2', daysOfCover: 2 },
      }),
    );

    expect(chains).toHaveLength(2);
    expect(chains[1]?.['set']).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: AlertSeverity.CRITICAL,
        description: '2 days of cover remaining',
      }),
    );
    expect(chains[1]?.['setParameter']).toHaveBeenCalledWith(
      'triggerData',
      JSON.stringify({ historyId: 'history-2', daysOfCover: 2 }),
    );
    expect(escalation.startEscalation).toHaveBeenCalledWith(existing, {
      severity: AlertSeverity.CRITICAL,
      matchKey: KEY,
          });
  });

  it('does not re-page when a concurrent delivery already won the severity rise', async () => {
    // SCENARIO: two CRITICAL occurrences race on a WARNING incident; this one loses.
    // EXPECTS: no escalation from the loser (the winner re-ran the ladder).
    const { service, escalation } = makeService({
      existingIncident: openIncident(AlertSeverity.WARNING),
      updates: {
        bumped: { escalation_level: 1, severity: AlertSeverity.WARNING },
        riseWins: false,
      },
    });

    await service.ensureIncident(makeSpec({ severity: AlertSeverity.CRITICAL }));

    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('does NOT de-escalate or re-page when a less severe occurrence arrives', async () => {
    const { service, escalation, chains } = makeService({
      existingIncident: openIncident(AlertSeverity.CRITICAL),
    });

    await service.ensureIncident(makeSpec({ severity: AlertSeverity.WARNING }));

    expect(chains).toHaveLength(1);
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('propagates a failed re-run escalation as an IncidentEscalationFailedError', async () => {
    // SCENARIO: severity rises, but the ladder cannot start (policy lookup down).
    // EXPECTS: the failure reaches the consumer typed as an escalation failure,
    //          which every farm-signal consumer re-drives (V-S1a-12).
    const { service, escalation } = makeService({
      existingIncident: openIncident(AlertSeverity.WARNING),
      updates: { bumped: { escalation_level: 1, severity: AlertSeverity.WARNING }, riseWins: true },
    });
    escalation.startEscalation.mockRejectedValueOnce(new Error('policy service down'));

    await expect(
      service.ensureIncident(makeSpec({ severity: AlertSeverity.CRITICAL })),
    ).rejects.toBeInstanceOf(IncidentEscalationFailedError);
  });

  it('propagates a failed first escalation after the incident is written', async () => {
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });
    escalation.startEscalation.mockRejectedValueOnce(new Error('outbox down'));

    await expect(service.ensureIncident(makeSpec())).rejects.toThrow(/outbox down/);
    expect(incidentRepo.save).toHaveBeenCalledTimes(1);
  });

  it('retries the FIRST escalation while the database says the open incident was never escalated', async () => {
    // SCENARIO: the bump's RETURNING row reports escalation_level 0 (no policy
    //           then, or a failed first level) — even though the in-memory read said 1.
    // EXPECTS: a 'first' escalation (the claim of level 0 keeps a concurrent
    //          retry from paging twice), at the database's severity.
    const { service, escalation } = makeService({
      existingIncident: openIncident(AlertSeverity.CRITICAL, 1),
      updates: { bumped: { escalation_level: 0, severity: AlertSeverity.CRITICAL } },
    });

    await service.ensureIncident(makeSpec());

    expect(escalation.startEscalation).toHaveBeenCalledWith(expect.anything(), {
      severity: AlertSeverity.CRITICAL,
      matchKey: KEY,
    });
  });

  it('joins the winning incident when a concurrent delivery opened it first', async () => {
    // SCENARIO: two deliveries of one condition both saw "no open incident"; this
    //           one lost the insert to uq_alert_incidents_open_signal.
    // EXPECTS: no second incident — the occurrence bumps the winner atomically.
    const winner = openIncident(AlertSeverity.CRITICAL);
    const { service, incidentRepo, escalation, chains } = makeService({ existingIncident: null });
    incidentRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    const race = new QueryFailedError(
      'INSERT',
      [],
      Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint: 'uq_alert_incidents_open_signal',
      }),
    );
    incidentRepo.save.mockRejectedValueOnce(race);

    await service.ensureIncident(makeSpec());

    expect(chains).toHaveLength(1);
    expect(chains[0]?.['where']).toHaveBeenCalledWith('id = :id', { id: winner.id });
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('rethrows any other insert failure', async () => {
    const { service, incidentRepo } = makeService({ existingIncident: null });
    incidentRepo.save.mockRejectedValueOnce(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('check violation'), {
          code: '23514',
          constraint: 'CHK_alert_incidents_rule_xor_signal',
        }),
      ),
    );

    await expect(service.ensureIncident(makeSpec())).rejects.toBeInstanceOf(QueryFailedError);
  });
});
