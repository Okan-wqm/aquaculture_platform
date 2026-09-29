/**
 * WaterQualityService — the measurement's site is DERIVED from the measured
 * unit and the alarm's actor is the AUTHENTICATED caller
 * (V-S1a-1 / V-S1b-1 / V-S1a-10 / V-S1b-5, ALERT-MEDIUM-007).
 *
 * The real `resolveMeasuredUnitSite`, `SiteAuthorizationService` and
 * `MeasurementActorService` run against the harness's unit directory and auth
 * membership double; every refusal is asserted to leave ZERO outbox rows and
 * nothing persisted.
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Role } from '@aquaculture/backend-common/decorators';

import { ParameterStatus, WaterQualityStatus } from '../entities/water-quality-measurement.entity';
import { MeasurementSource } from '../entities/water-quality-measurement.entity';
import type { WaterQualityCaller } from '../water-quality.service';
import {
  EQUIPMENT,
  SITE_A,
  SITE_B,
  TENANT,
  USER,
  activeMembers,
  buildService,
  createInput,
  of,
  throwError,
  type ServiceHarness,
} from './water-quality-service.harness';

const SITE_B_TANK = '77777777-7777-4777-8777-777777777777';
const SITE_A_TANK = '88888888-8888-4888-8888-888888888888';
const UNKNOWN_UNIT = '99999999-9999-4999-8999-999999999999';
const OTHER_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A MODULE_USER assigned to site A only. */
const SITE_A_OPERATOR: WaterQualityCaller = {
  sub: USER,
  roles: [Role.MODULE_USER],
  assignedSiteIds: [SITE_A],
};

const MANAGER: WaterQualityCaller = {
  sub: USER,
  roles: [Role.MODULE_MANAGER],
  assignedSiteIds: [],
};

function critical(harness: ServiceHarness): void {
  harness.evaluate.mockResolvedValue({
    overallStatus: WaterQualityStatus.CRITICAL,
    criticalCount: 1,
    warningCount: 0,
    optimalCount: 0,
    evaluations: [
      {
        parameter: 'dissolved_oxygen',
        value: 2,
        unit: 'mg/L',
        status: ParameterStatus.CRITICAL_LOW,
        criticalMin: 4,
      },
    ],
    recommendations: [],
  });
}

function criticalEventOf(
  harness: ServiceHarness,
): { eventType: string; siteId?: string; userId?: string } | undefined {
  return harness.enqueue.mock.calls
    .map(([event]) => event as { eventType: string; siteId?: string; userId?: string })
    .find((event) => event.eventType === 'WaterQualityCritical');
}

function persistedSiteId(harness: ServiceHarness): unknown {
  const created: unknown = harness.mockManager.create.mock.calls[0]?.[1];
  return (created as { siteId?: unknown } | undefined)?.siteId;
}

const threeUnits = { [EQUIPMENT]: SITE_A, [SITE_A_TANK]: SITE_A, [SITE_B_TANK]: SITE_B };

describe('WaterQualityService.create — site derived from the measured unit', () => {
  it('names, stores and authorizes on the unit site (event.siteId == unit site)', async () => {
    // SCENARIO: a critical manual reading naming only its equipment (site A).
    // EXPECTS: the stored row and the WaterQualityCritical event both carry site A.
    const harness = await buildService({ units: threeUnits });
    critical(harness);

    await harness.service.create(TENANT, createInput(), SITE_A_OPERATOR);

    expect(criticalEventOf(harness)).toMatchObject({ siteId: SITE_A });
    expect(persistedSiteId(harness)).toBe(SITE_A);
  });

  it('refuses a MODULE_USER recording on a foreign unit while asserting his own site — no outbox row', async () => {
    // SCENARIO: the verifier's attack — MODULE_USER of A sends {siteId: A, equipmentId: <B unit>}.
    // EXPECTS: 400 (the asserted site is not the unit's site), nothing saved, zero enqueues.
    const harness = await buildService({ units: threeUnits });
    critical(harness);

    await expect(
      harness.service.create(
        TENANT,
        createInput({ equipmentId: SITE_B_TANK, siteId: SITE_A }),
        SITE_A_OPERATOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.mockManager.save).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a MODULE_USER recording on a foreign unit without a site assertion — no outbox row', async () => {
    // SCENARIO: MODULE_USER of A names site B's unit and no siteId.
    // EXPECTS: 403 from the site policy on the DERIVED site B; zero enqueues.
    const harness = await buildService({ units: threeUnits });
    critical(harness);

    await expect(
      harness.service.create(TENANT, createInput({ equipmentId: SITE_B_TANK }), SITE_A_OPERATOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a tank/equipment pair spanning two sites, whoever the caller is', async () => {
    // SCENARIO: tankId in site A, equipmentId in site B, by a MODULE_MANAGER (who bypasses site checks).
    // EXPECTS: 400 — one reading cannot belong to two sites; zero enqueues.
    const harness = await buildService({ units: threeUnits });
    critical(harness);

    await expect(
      harness.service.create(
        TENANT,
        createInput({ equipmentId: SITE_B_TANK, tankId: SITE_A_TANK }),
        MANAGER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('accepts a tank/equipment pair of one site and keys the site on the unit', async () => {
    // SCENARIO: a probe (EQUIPMENT) in a tank (SITE_A_TANK), both in site A.
    // EXPECTS: accepted; the event names site A.
    const harness = await buildService({ units: threeUnits });
    critical(harness);

    await harness.service.create(TENANT, createInput({ tankId: SITE_A_TANK }), SITE_A_OPERATOR);

    expect(criticalEventOf(harness)).toMatchObject({ siteId: SITE_A });
  });

  it('answers 404 for an unknown unit', async () => {
    // SCENARIO: equipmentId names nothing in the tenant.
    // EXPECTS: NotFoundException; zero enqueues.
    const harness = await buildService({ units: threeUnits });

    await expect(
      harness.service.create(TENANT, createInput({ equipmentId: UNKNOWN_UNIT }), MANAGER),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a site assertion on a unit that has no site', async () => {
    // SCENARIO: the unit's department has no site; the caller asserts one anyway.
    // EXPECTS: 400 — a site-less unit cannot be claimed for any site.
    const harness = await buildService({ units: { [EQUIPMENT]: null } });

    await expect(
      harness.service.create(TENANT, createInput({ siteId: SITE_A }), MANAGER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('accepts a matching site assertion (old offline payloads still replay)', async () => {
    // SCENARIO: a queued AquaMobil payload asserting the unit's own site.
    // EXPECTS: accepted, stored under that site.
    const harness = await buildService({ units: threeUnits });

    await harness.service.create(TENANT, createInput({ siteId: SITE_A }), SITE_A_OPERATOR);

    expect(persistedSiteId(harness)).toBe(SITE_A);
  });
});

describe('WaterQualityService.createBatch — per-item derived site', () => {
  it('refuses a batch whose item names a foreign unit — no outbox row', async () => {
    // SCENARIO: MODULE_USER of A submits two items, the second on site B's unit.
    // EXPECTS: 403; the whole batch rolls back with zero enqueues.
    const harness = await buildService({ units: threeUnits });

    await expect(
      harness.service.createBatch(
        TENANT,
        {
          measuredAt: new Date('2026-06-14T08:00:00Z'),
          source: MeasurementSource.MANUAL,
          measurements: [
            {
              equipmentId: EQUIPMENT,
              dynamicParameters: { temperature: 14 },
              idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            },
            {
              equipmentId: SITE_B_TANK,
              dynamicParameters: { temperature: 14 },
              idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            },
          ],
        },
        SITE_A_OPERATOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });
});

describe('WaterQualityService.create — the actor is the authenticated caller (V-S1b-5)', () => {
  it('stamps the caller as the event actor and the reader when measuredBy is omitted', async () => {
    // SCENARIO: an operator records a critical reading without measuredBy.
    // EXPECTS: event.userId and the stored measuredBy are the caller.
    const harness = await buildService();
    critical(harness);

    await harness.service.create(TENANT, createInput(), MANAGER);

    expect(criticalEventOf(harness)).toMatchObject({ userId: USER });
    const created: unknown = harness.mockManager.create.mock.calls[0]?.[1];
    expect(created).toMatchObject({ measuredBy: USER });
  });

  it('refuses a MODULE_USER pinning the reading on someone else', async () => {
    // SCENARIO: a MODULE_USER sends measuredBy = another user.
    // EXPECTS: 403 before any membership lookup or write.
    const harness = await buildService();

    await expect(
      harness.service.create(TENANT, createInput({ measuredBy: OTHER_USER }), SITE_A_OPERATOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.membershipSend).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('lets a manager record for an active tenant user, but the actor stays the manager', async () => {
    // SCENARIO: a MODULE_MANAGER records a critical reading taken by a colleague.
    // EXPECTS: measuredBy = colleague (verified active by auth), event.userId = the manager.
    const harness = await buildService();
    critical(harness);
    harness.membershipSend.mockReturnValue(of(activeMembers([OTHER_USER])));

    await harness.service.create(TENANT, createInput({ measuredBy: OTHER_USER }), MANAGER);

    const created: unknown = harness.mockManager.create.mock.calls[0]?.[1];
    expect(created).toMatchObject({ measuredBy: OTHER_USER });
    expect(criticalEventOf(harness)).toMatchObject({ userId: USER });
  });

  it('refuses a measuredBy that is not an active user of the tenant', async () => {
    // SCENARIO: auth reports the id inactive / foreign.
    // EXPECTS: 400, nothing written.
    const harness = await buildService();
    harness.membershipSend.mockReturnValue(
      of({
        success: true,
        allValid: false,
        validUserIds: [],
        invalidUserIds: [OTHER_USER],
        inactiveUserIds: [],
      }),
    );

    await expect(
      harness.service.create(TENANT, createInput({ measuredBy: OTHER_USER }), MANAGER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when the user directory is unreachable', async () => {
    // SCENARIO: the membership query errors.
    // EXPECTS: 503 — an unverified name is never stored.
    const harness = await buildService();
    harness.membershipSend.mockReturnValue(throwError(() => new Error('no responders')));

    await expect(
      harness.service.create(TENANT, createInput({ measuredBy: OTHER_USER }), MANAGER),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });
});
