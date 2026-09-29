/**
 * K10 red-team, every subject (PR-T1 — V-T1a-5, V-T1a-6, V-T1b-1, and the
 * verifiers' "does the suite's role bypass RLS" item).
 *
 * Tenant A sends tenant B's real ids to EVERY farm AI subject through the
 * REAL responders, skeleton and query handlers, over a two-tenant PostgreSQL
 * whose tenant tables carry the production RLS policy, as an application role
 * that cannot bypass it. Then a responder that moves its own connection to
 * tenant B proves the reply names the tenant the connection served — and that
 * ai-service refuses it.
 */
import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { SecurityEventService } from '@aquaculture/backend-common/security';
import { collaborator } from '@aquaculture/testing';
import {
  FARM_AI_QUERY_SUBJECTS,
  isAiQueryRequestShape,
  isRecord,
  type TenantBoundReply,
} from '@platform/event-contracts';

import type { FarmAiResponder } from '../../../apps/farm-service/src/common/tenant-boundary/farm-ai-responder';
import { FARM_AI_OWNERS } from '../../../apps/farm-service/src/common/tenant-boundary/farm-ai-owners';
import { Tank } from '../../../apps/farm-service/src/tank/entities/tank.entity';
import { TenantBoundNatsClient } from '../../../apps/ai-service/src/tenant-boundary/tenant-bound-nats.client';
import { TenantBoundaryViolation } from '../../../apps/ai-service/src/tenant-boundary/tenant-boundary-violation';
import { TenantBoundaryViolationReporter } from '../../../apps/ai-service/src/tenant-boundary/tenant-boundary-violation.reporter';
import { buildHumanTurnContext } from '../../../apps/ai-service/src/tenant-boundary/tool-context.factory';

import { FARM_AI_SUBJECT_CASES, idFieldsOf } from './helpers/farm-ai-subject-requests';
import {
  bootFarmTwoTenantHarness,
  type FarmTwoTenantHarness,
  type OwnedIds,
} from './helpers/farm-two-tenant.harness';
import { InProcessNatsTransport } from './helpers/in-process-nats.transport';
import { readRlsPosture, REDTEAM_APP_ROLE } from './helpers/rls-app-role';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';
const USER_A = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';
const B_SECRET = 'SUBJ-B-SECRET';
const STALE = 'request.redteam.staleConnection';
const SEARCH_PATH_ONLY = 'request.redteam.searchPathOnly';

/**
 * Subjects whose REAL handler fails for every tenant today: defects this suite
 * found in code it runs, reported for registry IDs in PR-T1. They still prove
 * isolation (answered for A, nothing of B), but the liveness check below pins
 * them as failing, so the fix turns this suite red until the entry is removed.
 */
const FAILING_FOR_EVERY_TENANT: Readonly<Record<string, string>> = {
  [FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL]:
    'ListCriticalWaterQualityHandler joins on unquoted latest.tankId / latest.maxDate',
  [FARM_AI_QUERY_SUBJECTS.FINANCE_SUMMARY]:
    "the maintenance derived-cost source compares work_orders.status with 'CANCELLED' " +
    "(the enum value is 'cancelled')",
};

/** The id kind each owned request field names (FARM_AI_OWNERS' keys). */
const ID_KIND: Readonly<Record<string, keyof OwnedIds>> = {
  tankId: 'tankId',
  batchId: 'batchId',
  siteId: 'siteId',
  departmentId: 'departmentId',
  systemId: 'systemId',
  equipmentId: 'equipmentId',
  equipmentTypeId: 'equipmentTypeId',
  entityId: 'batchId',
};

/**
 * A responder with a bug the skeleton must catch: it moves its OWN connection
 * to tenant B (search_path and, in the stale case, the RLS tenant too) and
 * returns what it reads there — the "stale pooled search_path" class, made
 * deliberate. `seen` records what the handler read, to prove RLS in the
 * search_path-only case.
 */
@Controller()
class ConnectionMovingResponder {
  readonly seen: string[][] = [];

  constructor(
    private readonly skeleton: FarmAiResponder,
    private readonly victimSchema: string,
  ) {}

  @MessagePattern(STALE)
  stale(payload: unknown): Promise<TenantBoundReply<string[]>> {
    return this.answer(STALE, payload, true);
  }

  @MessagePattern(SEARCH_PATH_ONLY)
  searchPathOnly(payload: unknown): Promise<TenantBoundReply<string[]>> {
    return this.answer(SEARCH_PATH_ONLY, payload, false);
  }

  private answer(
    subject: string,
    payload: unknown,
    moveRlsTenant: boolean,
  ): Promise<TenantBoundReply<string[]>> {
    return this.skeleton.respond(
      {
        subject,
        isRequest: (value: unknown): value is { tenantId: string } =>
          isAiQueryRequestShape(value, []),
        handle: async (_request, scope) => {
          await scope.query(`SELECT set_config('search_path', $1, true)`, [
            `"${this.victimSchema}", "farm", public`,
          ]);
          if (moveRlsTenant) {
            await scope.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_B]);
          }
          const codes = (await scope.manager.find(Tank)).map((tank) => tank.code);
          this.seen.push(codes);
          return codes;
        },
      },
      payload,
    );
  }
}

describe('K10 red-team: every farm AI subject refuses tenant B ids for tenant A', () => {
  let farm: FarmTwoTenantHarness;

  beforeAll(async () => {
    farm = await bootFarmTwoTenantHarness({
      tenantAId: TENANT_A,
      tenantBId: TENANT_B,
      userId: USER_A,
      tenantBSecretPrefix: B_SECRET,
    });
  });

  afterAll(async () => {
    await farm.close();
  });

  const noTenantB = (label: string, value: unknown): void => {
    const text = JSON.stringify(value);
    expect({ label, leaksCode: text.includes(B_SECRET) }).toEqual({ label, leaksCode: false });
  };

  it('the responders run as a role that cannot bypass RLS, over tables that all carry the policy', async () => {
    // SCENARIO: the suite would prove nothing about RLS as a superuser, a BYPASSRLS role, or a
    //           table owner without FORCE.
    // EXPECTS: the app role is none of these, and every tenant-keyed table of both tenant schemas
    //          has RLS enabled + forced with a policy.
    const posture = await readRlsPosture(farm.dataSource, farm.tenantSchemas);
    expect(posture).toEqual({
      role: REDTEAM_APP_ROLE,
      superuser: false,
      bypassRls: false,
      unprotectedTables: [],
    });
  });

  it('covers every subject of the contract (sanity)', () => {
    const transport = new InProcessNatsTransport(farm.responders);
    const subjects = Object.values(FARM_AI_QUERY_SUBJECTS);
    expect(Object.keys(FARM_AI_SUBJECT_CASES).sort()).toEqual([...subjects].sort());
    expect(subjects.filter((subject) => !transport.subjects.includes(subject))).toEqual([]);
  });

  it.each(Object.entries(FARM_AI_SUBJECT_CASES))(
    '%s: names every id it accepts, and tenant B ids are NOT_FOUND for tenant A',
    async (subject, subjectCase) => {
      // SCENARIO: tenant A's request carries tenant B's real ids in every id field the subject
      //           accepts (a leak, a guess, a prompt injection).
      // EXPECTS: the request passes the subject's guard (this is not an INVALID_REQUEST test);
      //          adding any other owned id field makes the guard refuse (the case names every
      //          id); the reply is NOT_FOUND for tenant A — or, for a subject that takes no id,
      //          a successful answer served for A — and carries nothing of tenant B.
      const request = { tenantId: TENANT_A, ...subjectCase.request(farm.tenantB.ids) };
      expect({ subject, guardAccepts: subjectCase.guard(request) }).toEqual({
        subject,
        guardAccepts: true,
      });
      for (const field of Object.keys(FARM_AI_OWNERS).filter((f) => !(f in request))) {
        const widened = { ...request, [field]: farm.tenantB.ids[ID_KIND[field] ?? 'tankId'] };
        expect({ subject, field, guardAccepts: subjectCase.guard(widened) }).toEqual({
          subject,
          field,
          guardAccepts: false,
        });
      }

      const reply = await new InProcessNatsTransport(farm.responders).ask(subject, request);

      noTenantB(subject, reply);
      if (idFieldsOf(request).length > 0) {
        expect({ subject, reply }).toEqual({
          subject,
          reply: { ok: false, tenantId: TENANT_A, error: 'NOT_FOUND' },
        });
      } else {
        // An answer, not an error that happens to name A: the REAL handler served A.
        expect({
          subject,
          ok: isRecord(reply) ? reply['ok'] : null,
          servedFor: isRecord(reply) ? reply['tenantId'] : null,
        }).toEqual({ subject, ok: !(subject in FAILING_FOR_EVERY_TENANT), servedFor: TENANT_A });
      }
    },
  );

  it.each(Object.entries(ID_KIND))(
    'control: tenant B %s resolves for tenant B — the NOT_FOUND for A is isolation, not absence',
    async (field, kind) => {
      // SCENARIO: the same skeleton and owner registry, asked as tenant B and as tenant A.
      // EXPECTS: B's own id resolves for B; the same id is NOT_FOUND for A.
      const fields: Record<string, unknown> =
        field === 'entityId'
          ? { entityType: 'batch', entityId: farm.tenantB.ids[kind] }
          : { [field]: farm.tenantB.ids[kind] };
      const probe = (tenantId: string): Promise<TenantBoundReply<string>> =>
        farm.skeleton.respond(
          {
            subject: 'request.redteam.ownerProbe',
            isRequest: (value: unknown): value is { tenantId: string } => isRecord(value),
            handle: async () => 'resolved',
          },
          { tenantId, ...fields },
        );

      await expect(probe(TENANT_B)).resolves.toEqual({
        ok: true,
        tenantId: TENANT_B,
        data: 'resolved',
      });
      await expect(probe(TENANT_A)).resolves.toEqual({
        ok: false,
        tenantId: TENANT_A,
        error: 'NOT_FOUND',
      });
    },
  );

  describe('a responder whose connection serves tenant B (V-T1a-5)', () => {
    const reporterEvents = jest.fn().mockResolvedValue(undefined);
    const ctx = buildHumanTurnContext({
      tenantId: TENANT_A,
      userId: USER_A,
      userRoles: ['MODULE_MANAGER'],
      correlationId: 'corr-stale',
      persona: 'manager-farm-production-v1',
      personaTier: 'manager',
      offeredToolNames: [],
      actuationPolicy: 'confirm_required',
    });
    const clientOver = (transport: InProcessNatsTransport): TenantBoundNatsClient =>
      new TenantBoundNatsClient(
        transport,
        new TenantBoundaryViolationReporter(
          collaborator<SecurityEventService>(
            { publishTenantAccessDenied: reporterEvents },
            'SecurityEventService',
          ),
        ),
      );
    const isCodes = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((code) => typeof code === 'string');

    it("withholds B's rows and names B, so ai-service stops the run", async () => {
      // SCENARIO: the handler moves its connection's search_path AND RLS tenant to B and reads
      //           B's tanks inside tenant A's scope.
      // EXPECTS: the skeleton reads the served tenant back from the connection (B), withholds the
      //          rows, names B; the client refuses it as a tenant mismatch; nothing of B crosses.
      const responder = new ConnectionMovingResponder(farm.skeleton, farm.tenantSchemas[1] ?? '');
      const transport = new InProcessNatsTransport([responder]);

      await expect(
        clientOver(transport).request(ctx, {
          subject: STALE,
          fields: {},
          isData: isCodes,
          timeoutMs: 5000,
        }),
      ).rejects.toBeInstanceOf(TenantBoundaryViolation);

      expect(responder.seen).toEqual([[`${B_SECRET}-TANK`]]);
      expect(transport.exchanges.map((e) => e.reply)).toEqual([
        { ok: false, tenantId: TENANT_B, error: 'INTERNAL_ERROR' },
      ]);
      noTenantB('wire', transport.exchanges);
    });

    it('under the RLS-bound role, moving only the search_path reads nothing of B', async () => {
      // SCENARIO: the handler moves only the search_path to B; the RLS tenant stays A.
      // EXPECTS: RLS hides every B row from the app role, and the connection no longer serves one
      //          tenant consistently — the reply names no tenant and the client refuses it.
      const responder = new ConnectionMovingResponder(farm.skeleton, farm.tenantSchemas[1] ?? '');
      const transport = new InProcessNatsTransport([responder]);

      await expect(
        clientOver(transport).request(ctx, {
          subject: SEARCH_PATH_ONLY,
          fields: {},
          isData: isCodes,
          timeoutMs: 5000,
        }),
      ).rejects.toBeInstanceOf(TenantBoundaryViolation);

      expect(responder.seen).toEqual([[]]);
      expect(transport.exchanges.map((e) => e.reply)).toEqual([
        { ok: false, tenantId: null, error: 'INTERNAL_ERROR' },
      ]);
    });
  });
});
