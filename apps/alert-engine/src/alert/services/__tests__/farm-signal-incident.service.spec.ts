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
 */
import { createMockRepository, stub } from '@aquaculture/testing';
import type { DataSource, EntityManager } from 'typeorm';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../../../database/entities/alert-incident.entity';
import { EscalationManagerService } from '../../../escalation/escalation-manager.service';
import { AlertHistory } from '../../entities/alert-history.entity';
import {
  FarmSignalAlertSpec,
  FarmSignalIncidentService,
  FarmSignalIncidentSpec,
} from '../farm-signal-incident.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const RULE_ID = 'system:mortality:cumulative_rate';
const TRIGGERED_AT = new Date('2026-06-10T08:00:00.000Z');

function makeSpec(overrides: Partial<FarmSignalIncidentSpec> = {}): FarmSignalIncidentSpec {
  return {
    tenantId: TENANT_ID,
    ruleId: RULE_ID,
    title: 'High Mortality (cumulative_rate): batch b-1',
    description: 'Cumulative mortality rate 12.00% is critical',
    severity: AlertSeverity.CRITICAL,
    triggerData: { historyId: 'history-1', batchId: 'b-1' },
    triggeredAt: TRIGGERED_AT,
    signalLabel: 'mortality',
    ...overrides,
  };
}

/**
 * Structurally-sufficient open-incident fixture: a single typed widening (not
 * an unsafe cast). The service reads status/severity/occurrenceCount and calls
 * `recordOccurrence` / `addTimelineEvent` on it.
 */
function openIncident(severity: AlertSeverity): AlertIncident & {
  recordOccurrence: jest.Mock;
  addTimelineEvent: jest.Mock;
} {
  return {
    id: 'incident-existing',
    occurrenceCount: 1,
    status: IncidentStatus.NEW,
    severity,
    description: 'opened seven days ago',
    triggerData: { historyId: 'history-1' },
    recordOccurrence: jest.fn(),
    addTimelineEvent: jest.fn(),
  } as Partial<AlertIncident> as AlertIncident & {
    recordOccurrence: jest.Mock;
    addTimelineEvent: jest.Mock;
  };
}

/** Minimal EscalationManagerService double — only startEscalation is called. */
type EscalationDouble = jest.Mocked<Pick<EscalationManagerService, 'startEscalation'>>;

function makeService(opts: { existingIncident?: AlertIncident | null } = {}): {
  service: FarmSignalIncidentService;
  incidentRepo: jest.Mocked<import('typeorm').Repository<AlertIncident>>;
  escalation: EscalationDouble;
  manager: jest.Mocked<Pick<EntityManager, 'save' | 'create' | 'getRepository'>>;
  transaction: jest.Mock;
  order: string[];
} {
  const order: string[] = [];
  const incidentRepo = createMockRepository<AlertIncident>();
  incidentRepo.findOne.mockResolvedValue(opts.existingIncident ?? null);
  incidentRepo.create.mockImplementation((dto) => {
    const incident = { id: 'incident-1', ...dto } as AlertIncident;
    incident.addTimelineEvent = jest.fn();
    incident.recordOccurrence = jest.fn();
    return incident;
  });
  incidentRepo.save.mockImplementation(async (i) => i as AlertIncident);

  const escalation: EscalationDouble = {
    startEscalation: jest.fn().mockImplementation(async () => {
      order.push('escalation');
      return null;
    }),
  };

  // The transaction's manager: the alarm row is saved through it, the incident
  // through the repository it hands out. Both are the SAME transaction.
  const manager = {
    create: jest.fn().mockImplementation((_entity: unknown, row: object) => ({ ...row })),
    save: jest.fn().mockImplementation(async (_entity: unknown, row: object) => ({
      ...row,
      id: 'history-new',
    })),
    getRepository: jest.fn().mockReturnValue(incidentRepo),
  };
  const transaction = jest.fn().mockImplementation(async (work: (m: unknown) => Promise<unknown>) => {
    const result = await work(manager);
    order.push('commit');
    return result;
  });
  // The service's escalation param is narrowed to Pick<…,'startEscalation'>,
  // so the double slots in with NO cast.
  const service = new FarmSignalIncidentService(
    incidentRepo,
    escalation,
    stub<DataSource>({ transaction }),
  );
  return { service, incidentRepo, escalation, manager, transaction, order };
}

describe('FarmSignalIncidentService', () => {
  it('creates a NEW incident and starts escalation when none is open', async () => {
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });

    await service.ensureIncident(makeSpec());

    expect(incidentRepo.create).toHaveBeenCalledTimes(1);
    const created = incidentRepo.create.mock.calls[0]?.[0] as Partial<AlertIncident>;
    expect(created.ruleId).toBe(RULE_ID);
    expect(created.title).toBe('High Mortality (cumulative_rate): batch b-1');
    expect(created.severity).toBe(AlertSeverity.CRITICAL);
    expect(created.occurrenceCount).toBe(1);
    expect(created.lastOccurredAt).toBe(TRIGGERED_AT);

    expect(incidentRepo.save).toHaveBeenCalled();
    expect(escalation.startEscalation).toHaveBeenCalledTimes(1);
    const [incidentArg, severityArg, ruleArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.CRITICAL);
    expect(ruleArg).toBe(RULE_ID);
    expect(incidentArg).toBeDefined();
  });

  it('carries the caller severity through to the incident and escalation', async () => {
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });

    await service.ensureIncident(makeSpec({ severity: AlertSeverity.WARNING }));

    const created = incidentRepo.create.mock.calls[0]?.[0] as Partial<AlertIncident>;
    expect(created.severity).toBe(AlertSeverity.WARNING);
    const [, severityArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.WARNING);
  });

  it('bumps an existing open incident instead of creating a new one', async () => {
    const existing = openIncident(AlertSeverity.CRITICAL);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(makeSpec());

    expect(existing.recordOccurrence).toHaveBeenCalledTimes(1);
    expect(existing.recordOccurrence).toHaveBeenCalledWith(TRIGGERED_AT);
    expect(incidentRepo.save).toHaveBeenCalledWith(existing);
    expect(incidentRepo.create).not.toHaveBeenCalled();
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  /**
   * W7 / FARM-MEDIUM-259 — dedup used to freeze an incident at the severity it
   * was FIRST opened with. A feed-stockout opened at WARNING on day 7 of cover
   * stayed WARNING all the way down to day 1: the CRITICAL threshold the
   * coverage service recomputed every morning was passed in and discarded,
   * because the escalation ladder is chosen at `startEscalation` time and that
   * only ran on creation.
   */
  it('promotes an open incident when a MORE severe occurrence arrives, and re-runs escalation', async () => {
    const existing = openIncident(AlertSeverity.WARNING);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(
      makeSpec({
        severity: AlertSeverity.CRITICAL,
        description: '2 days of cover remaining',
        triggerData: { historyId: 'history-2', daysOfCover: 2 },
      }),
    );

    expect(existing.severity).toBe(AlertSeverity.CRITICAL);
    // The operator opening the incident must read the CURRENT reason, not the
    // one it was opened with seven days ago.
    expect(existing.description).toBe('2 days of cover remaining');
    expect(existing.triggerData).toEqual({ historyId: 'history-2', daysOfCover: 2 });
    expect(existing.addTimelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TimelineEventType.ESCALATED,
        data: { previousSeverity: AlertSeverity.WARNING, severity: AlertSeverity.CRITICAL },
      }),
    );
    expect(incidentRepo.create).not.toHaveBeenCalled();

    expect(escalation.startEscalation).toHaveBeenCalledTimes(1);
    const [, severityArg, ruleArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.CRITICAL);
    expect(ruleArg).toBe(RULE_ID);
  });

  it('does NOT de-escalate or re-page when a less severe occurrence arrives', async () => {
    const existing = openIncident(AlertSeverity.CRITICAL);
    const { service, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(makeSpec({ severity: AlertSeverity.WARNING }));

    // De-escalation is an operator decision (resolve/close); re-running the
    // ladder on every repeat occurrence would be a pager storm.
    expect(existing.severity).toBe(AlertSeverity.CRITICAL);
    expect(existing.addTimelineEvent).not.toHaveBeenCalled();
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('keeps the escalated incident write when the re-run escalation rejects', async () => {
    const existing = openIncident(AlertSeverity.WARNING);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });
    escalation.startEscalation.mockRejectedValueOnce(new Error('policy service down'));

    await expect(
      service.ensureIncident(makeSpec({ severity: AlertSeverity.CRITICAL })),
    ).resolves.toBeUndefined();
    expect(incidentRepo.save).toHaveBeenCalledWith(existing);
  });

  it('does not fail the incident write when escalation rejects (non-blocking)', async () => {
    const { service, escalation } = makeService({ existingIncident: null });
    escalation.startEscalation.mockRejectedValueOnce(new Error('policy service down'));

    // The rejected escalation is swallowed — the already-landed incident write
    // must not be undone by a downstream escalation failure.
    await expect(service.ensureIncident(makeSpec())).resolves.toBeUndefined();
  });
});

/** The ids of every incident the repository was asked to write. */
function savedIncidentIds(repo: jest.Mocked<import('typeorm').Repository<AlertIncident>>): unknown[] {
  return repo.save.mock.calls.map(([row]) => (row as { id?: unknown }).id);
}

describe('FarmSignalIncidentService.raise — the alarm and its incident, atomically and once', () => {
  const DEDUPE_KEY = '3f2f6c3e-7a33-4e4e-9a52-0e3a1d5f6a71';

  function makeAlert(overrides: Partial<FarmSignalAlertSpec> = {}): FarmSignalAlertSpec {
    return {
      ...makeSpec({ ruleId: 'system:meal-underfed:unit-1', signalLabel: 'meal-underfed' }),
      dedupeKey: DEDUPE_KEY,
      history: {
        ruleName: 'Meal Underfed',
        severity: AlertSeverity.CRITICAL,
        message: 'unit T1 was underfed',
        triggeringData: { unitId: 'unit-1' },
        triggeredAt: TRIGGERED_AT,
      },
      triggerData: { unitId: 'unit-1' },
      ...overrides,
    };
  }

  it('writes the alarm row and the incident in ONE transaction, the alarm keyed by the dedupe key', async () => {
    const { service, manager, transaction, incidentRepo } = makeService();

    await expect(service.raise(makeAlert())).resolves.toBe('raised');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(manager.create).toHaveBeenCalledWith(
      AlertHistory,
      expect.objectContaining({
        ruleId: 'system:meal-underfed:unit-1',
        tenantId: TENANT_ID,
        sourceEventId: DEDUPE_KEY,
        ruleName: 'Meal Underfed',
      }),
    );
    expect(manager.save).toHaveBeenCalledWith(AlertHistory, expect.anything());
    // The incident goes through the transaction's own repository, never the injected one.
    expect(manager.getRepository).toHaveBeenCalledWith(AlertIncident);
    const created = incidentRepo.create.mock.calls[0]?.[0] as Partial<AlertIncident>;
    expect(created.ruleId).toBe('system:meal-underfed:unit-1');
    // The breadcrumb links the incident to the alarm that was just written.
    expect(created.triggerData).toEqual(expect.objectContaining({ historyId: 'history-new' }));
  });

  it('starts escalation only AFTER the commit, and only for a new incident', async () => {
    const { service, escalation, order } = makeService();

    await service.raise(makeAlert());

    expect(escalation.startEscalation).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['commit', 'escalation']);
  });

  it('a signal for an open incident only counts it: no escalation, no second incident', async () => {
    const open = openIncident(AlertSeverity.CRITICAL);
    const { service, escalation, incidentRepo } = makeService({ existingIncident: open });

    await expect(service.raise(makeAlert())).resolves.toBe('raised');

    expect(open.recordOccurrence).toHaveBeenCalledWith(TRIGGERED_AT);
    // Only the open incident is written: no second incident row.
    expect(savedIncidentIds(incidentRepo)).toEqual(['incident-existing']);
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('a more severe signal promotes the open incident and re-runs the ladder after the commit', async () => {
    const open = openIncident(AlertSeverity.WARNING);
    const { service, escalation, order } = makeService({ existingIncident: open });

    await service.raise(makeAlert({ severity: AlertSeverity.CRITICAL }));

    expect(open.severity).toBe(AlertSeverity.CRITICAL);
    expect(open.addTimelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: TimelineEventType.ESCALATED }),
    );
    expect(order).toEqual(['commit', 'escalation']);
    // The tenant-scoped repository hands back the saved row, tenant stamped.
    expect(escalation.startEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'incident-existing',
        severity: AlertSeverity.CRITICAL,
        tenantId: TENANT_ID,
      }),
      AlertSeverity.CRITICAL,
      'system:meal-underfed:unit-1',
    );
  });

  it('a delivery that already landed (unique violation on the key) is a DUPLICATE: nothing written, nothing escalated', async () => {
    const { service, transaction, escalation } = makeService();
    transaction.mockRejectedValue(Object.assign(new Error('duplicate key value'), { code: '23505' }));

    await expect(service.raise(makeAlert())).resolves.toBe('duplicate');

    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('any other failure propagates and escalates nothing: the handler retries or dead-letters', async () => {
    const { service, transaction, escalation } = makeService();
    transaction.mockRejectedValue(new Error('connection reset'));

    await expect(service.raise(makeAlert())).rejects.toThrow('connection reset');

    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('a failing incident write rolls the alarm back with it: the transaction rejects as a whole', async () => {
    const { service, incidentRepo, manager } = makeService();
    incidentRepo.save.mockRejectedValue(new Error('incident write failed'));

    await expect(service.raise(makeAlert())).rejects.toThrow('incident write failed');

    // The alarm was written INSIDE the transaction that failed — it is not
    // left behind for the redelivery to write again.
    expect(manager.save).toHaveBeenCalledWith(AlertHistory, expect.anything());
  });
});
