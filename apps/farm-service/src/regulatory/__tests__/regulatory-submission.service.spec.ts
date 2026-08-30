/**
 * RegulatorySubmissionService — persist-first submit, failure classification,
 * and retry replay (RPT-018).
 *
 * This is the SSoT for the outcome-handling the interactive submit path and the
 * 30-minute retry sweep both share, so it is tested here once:
 *   - submitWithRecord: PENDING persisted before the regulator call; success →
 *     markSubmitted; a persist error AFTER acceptance does NOT relabel the row;
 *     TRANSIENT failure → recordFailure with the next backoff; PERMANENT failure
 *     → applyFailure + outbox RegulatoryReportSubmissionFailedEvent in ONE txn.
 *   - resubmit: not-found / non-REST guards; the stored payload is re-validated
 *     through the brand gate (a now-invalid payload becomes PERMANENT, never a
 *     re-send); a valid replay applies the outcome under the same klientReferanse.
 *   - classifyFailure: the transient-vs-permanent decision matrix.
 *   - computeNextAttempt: exponential backoff capped at 6h.
 */
import { createMockDataSource } from '@aquaculture/testing';
import { OutboxPublisher } from '@platform/outbox';

import { RegulatorySubmissionService } from '../services/regulatory-submission.service';
import { MattilsynetApiService, MattilsynetApiResponse } from '../mattilsynet-api.service';
import { RegulatoryReportStoreService } from '../services/regulatory-report-store.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import {
  MattilsynetSchemaValidatorService,
  MattilsynetSchemaValidationError,
} from '../services/mattilsynet-schema-validator.service';
import {
  RegulatoryFailureClass,
  RegulatoryReport,
  RegulatoryReportType,
} from '../entities/regulatory-report.entity';

const TENANT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const USER_ID = 'user-001';

function makeRow(overrides: Partial<RegulatoryReport> = {}): RegulatoryReport {
  const row = new RegulatoryReport();
  row.id = 'row-777';
  row.tenantId = TENANT_ID;
  row.reportType = RegulatoryReportType.SEA_LICE;
  row.klientReferanse = 'ref-777';
  row.siteId = 'site-1';
  row.lokalitetsnummer = 12345;
  row.attemptCount = 0;
  Object.assign(row, overrides);
  return row;
}

const submitInput = {
  klientReferanse: 'ref-777',
  siteId: 'site-1',
  lokalitetsnummer: 12345,
};

// The submit* methods require a branded ValidatedPayload; the store persists the
// raw form. Neither shape is validated by the mocks — a plain object suffices.
const rawPayload = { klientReferanse: 'ref-777', lokalitetsnummer: 12345 } as never;

describe('RegulatorySubmissionService', () => {
  let service: RegulatorySubmissionService;
  let mocks: ReturnType<typeof createMockDataSource>;
  let submitByType: jest.Mock;
  let validate: jest.Mock;
  let recordPending: jest.Mock;
  let markSubmitted: jest.Mock;
  let recordFailure: jest.Mock;
  let applyFailure: jest.Mock;
  let findById: jest.Mock;
  let enqueue: jest.Mock;

  beforeEach(() => {
    mocks = createMockDataSource();
    submitByType = jest.fn();
    validate = jest.fn().mockImplementation((_type: unknown, payload: unknown) => payload);
    recordPending = jest.fn().mockResolvedValue(makeRow());
    markSubmitted = jest.fn().mockResolvedValue(undefined);
    recordFailure = jest.fn().mockResolvedValue(undefined);
    applyFailure = jest
      .fn()
      .mockImplementation((_m, _t, _id, feilmelding, failureClass) =>
        Promise.resolve(makeRow({ feilmelding, failureClass, attemptCount: 1 })),
      );
    findById = jest.fn();
    enqueue = jest.fn().mockResolvedValue(undefined);

    const api: Pick<MattilsynetApiService, 'submitByType'> = { submitByType };
    const validator: Pick<MattilsynetSchemaValidatorService, 'validate'> = { validate };
    const store: Pick<
      RegulatoryReportStoreService,
      'recordPending' | 'markSubmitted' | 'recordFailure' | 'applyFailure' | 'findById'
    > = { recordPending, markSubmitted, recordFailure, applyFailure, findById };
    const settings: Pick<RegulatorySettingsService, 'getEffectiveSiteLocalityMappings'> = {
      getEffectiveSiteLocalityMappings: jest.fn().mockResolvedValue({}),
    };
    const outbox: Pick<OutboxPublisher, 'enqueue'> = { enqueue };

    service = new RegulatorySubmissionService(
      mocks.mockDataSource,
      api as MattilsynetApiService,
      validator as MattilsynetSchemaValidatorService,
      store as RegulatoryReportStoreService,
      settings as RegulatorySettingsService,
      outbox as OutboxPublisher,
    );
  });

  // ==========================================================================
  // classifyFailure matrix
  // ==========================================================================

  describe('classifyFailure', () => {
    const cases: Array<[string, MattilsynetApiResponse, RegulatoryFailureClass]> = [
      ['network error', { success: false, isNetworkError: true }, RegulatoryFailureClass.TRANSIENT],
      [
        'validation errors',
        { success: false, valideringsfeil: [{ felt: 'x', melding: 'y' }] },
        RegulatoryFailureClass.PERMANENT,
      ],
      ['no status (unknown)', { success: false }, RegulatoryFailureClass.TRANSIENT],
      ['500', { success: false, httpStatus: 500 }, RegulatoryFailureClass.TRANSIENT],
      ['503', { success: false, httpStatus: 503 }, RegulatoryFailureClass.TRANSIENT],
      ['401', { success: false, httpStatus: 401 }, RegulatoryFailureClass.TRANSIENT],
      ['403', { success: false, httpStatus: 403 }, RegulatoryFailureClass.TRANSIENT],
      ['408', { success: false, httpStatus: 408 }, RegulatoryFailureClass.TRANSIENT],
      ['429', { success: false, httpStatus: 429 }, RegulatoryFailureClass.TRANSIENT],
      ['400', { success: false, httpStatus: 400 }, RegulatoryFailureClass.PERMANENT],
      ['422', { success: false, httpStatus: 422 }, RegulatoryFailureClass.PERMANENT],
    ];

    it.each(cases)('%s → %s', (_label, result, expected) => {
      expect(RegulatorySubmissionService.classifyFailure(result)).toBe(expected);
    });

    it('classifies validation errors PERMANENT even alongside a 5xx status', () => {
      // A body that carries valideringsfeil is a client-side rejection — retrying
      // it re-sends a payload the regulator already refused.
      expect(
        RegulatorySubmissionService.classifyFailure({
          success: false,
          httpStatus: 500,
          valideringsfeil: [{ felt: 'x', melding: 'y' }],
        }),
      ).toBe(RegulatoryFailureClass.PERMANENT);
    });
  });

  // ==========================================================================
  // computeNextAttempt backoff
  // ==========================================================================

  describe('computeNextAttempt (full jitter)', () => {
    const NOW = new Date('2026-07-06T00:00:00Z');
    // random()=1 samples the top of the [0, cap] window, so the cap per attempt
    // is asserted deterministically without depending on Math.random.
    const maxJitter = (): number => 1;
    const minJitter = (): number => 0;

    it('caps grow exponentially per attempt: 15m, 30m, 60m …', () => {
      expect(RegulatorySubmissionService.computeNextAttempt(1, NOW, maxJitter).getTime()).toBe(
        NOW.getTime() + 15 * 60_000,
      );
      expect(RegulatorySubmissionService.computeNextAttempt(2, NOW, maxJitter).getTime()).toBe(
        NOW.getTime() + 30 * 60_000,
      );
      expect(RegulatorySubmissionService.computeNextAttempt(3, NOW, maxJitter).getTime()).toBe(
        NOW.getTime() + 60 * 60_000,
      );
    });

    it('caps the backoff window at 6 hours', () => {
      // attempt 6 would be 15m×32 = 8h uncapped → clamped to 6h.
      expect(RegulatorySubmissionService.computeNextAttempt(6, NOW, maxJitter).getTime()).toBe(
        NOW.getTime() + 6 * 60 * 60_000,
      );
      expect(RegulatorySubmissionService.computeNextAttempt(20, NOW, maxJitter).getTime()).toBe(
        NOW.getTime() + 6 * 60 * 60_000,
      );
    });

    it('samples the FULL window [0, cap] so a failure cohort decorrelates', () => {
      // random()=0 is the floor (immediate), random()=1 is the cap — proving the
      // delay is jittered across the window rather than a fixed deterministic value.
      expect(RegulatorySubmissionService.computeNextAttempt(3, NOW, minJitter).getTime()).toBe(
        NOW.getTime(),
      );
      expect(RegulatorySubmissionService.computeNextAttempt(3, NOW, () => 0.5).getTime()).toBe(
        NOW.getTime() + 30 * 60_000,
      );
    });

    it('keeps the real (Math.random-backed) delay within [0, cap]', () => {
      const cap = 6 * 60 * 60_000;
      for (let i = 0; i < 50; i++) {
        const delay =
          RegulatorySubmissionService.computeNextAttempt(10, NOW).getTime() - NOW.getTime();
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(cap);
      }
    });
  });

  // ==========================================================================
  // submitWithRecord
  // ==========================================================================

  describe('submitWithRecord', () => {
    it('persists PENDING before the regulator call and marks SUBMITTED on success', async () => {
      const submit = jest.fn().mockImplementation(() => {
        expect(recordPending).toHaveBeenCalledTimes(1);
        return Promise.resolve({ success: true, referanse: 'MT-1', klientReferanse: 'ref-777' });
      });

      const result = await service.submitWithRecord(
        TENANT_ID,
        USER_ID,
        RegulatoryReportType.SEA_LICE,
        submitInput,
        { year: 2026, week: 26 },
        rawPayload,
        submit,
      );

      expect(result.success).toBe(true);
      expect(result.reportId).toBe('row-777');
      expect(markSubmitted).toHaveBeenCalledWith(TENANT_ID, 'row-777', 'MT-1');
      expect(recordFailure).not.toHaveBeenCalled();
    });

    it('does NOT relabel an accepted submission when persisting the outcome throws', async () => {
      markSubmitted.mockRejectedValueOnce(new Error('db write timeout'));
      const submit = jest.fn().mockResolvedValue({ success: true, referanse: 'MT-1' });

      const result = await service.submitWithRecord(
        TENANT_ID,
        USER_ID,
        RegulatoryReportType.SEA_LICE,
        submitInput,
        { year: 2026, week: 26 },
        rawPayload,
        submit,
      );

      expect(result.success).toBe(true);
      expect(recordFailure).not.toHaveBeenCalled();
    });

    it('records a TRANSIENT failure with the next backoff when the call throws (network)', async () => {
      recordPending.mockResolvedValue(makeRow({ attemptCount: 0 }));
      const submit = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      const result = await service.submitWithRecord(
        TENANT_ID,
        USER_ID,
        RegulatoryReportType.SEA_LICE,
        submitInput,
        { year: 2026, week: 26 },
        rawPayload,
        submit,
      );

      expect(result.success).toBe(false);
      expect(result.feilmelding).toBe('ECONNRESET');
      expect(recordFailure).toHaveBeenCalledWith(
        TENANT_ID,
        'row-777',
        'ECONNRESET',
        RegulatoryFailureClass.TRANSIENT,
        expect.any(Date),
      );
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('dead-letters a transient failure once the retry budget is exhausted (PRODUCT-JOB-HIGH-001)', async () => {
      // attemptCount 11 → this failure is attempt 12 = MAX_TRANSIENT_ATTEMPTS.
      recordPending.mockResolvedValue(makeRow({ attemptCount: 11 }));
      const submit = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      const result = await service.submitWithRecord(
        TENANT_ID,
        USER_ID,
        RegulatoryReportType.SEA_LICE,
        submitInput,
        { year: 2026, week: 26 },
        rawPayload,
        submit,
      );

      expect(result.success).toBe(false);
      // Escalated to a terminal PERMANENT failure + operator alert, NOT rescheduled.
      expect(recordFailure).not.toHaveBeenCalled();
      expect(applyFailure).toHaveBeenCalledWith(
        mocks.mockManager,
        TENANT_ID,
        'row-777',
        expect.stringContaining('gave up after 12 transient attempts'),
        RegulatoryFailureClass.PERMANENT,
        null,
      );
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('marks a PERMANENT failure terminal and raises the outbox event in one txn', async () => {
      const submit = jest.fn().mockResolvedValue({
        success: false,
        httpStatus: 400,
        valideringsfeil: [{ felt: 'lusetelling', melding: 'ugyldig' }],
      });

      const result = await service.submitWithRecord(
        TENANT_ID,
        USER_ID,
        RegulatoryReportType.SEA_LICE,
        submitInput,
        { year: 2026, week: 26 },
        rawPayload,
        submit,
      );

      expect(result.success).toBe(false);
      expect(applyFailure).toHaveBeenCalledWith(
        mocks.mockManager,
        TENANT_ID,
        'row-777',
        'lusetelling: ugyldig',
        RegulatoryFailureClass.PERMANENT,
        null,
      );
      expect(enqueue).toHaveBeenCalledTimes(1);
      const [event, manager, opts] = enqueue.mock.calls[0];
      expect(event.eventType).toBe('RegulatoryReportSubmissionFailed');
      expect(event.reportId).toBe('row-777');
      expect(manager).toBe(mocks.mockManager);
      expect(opts.idempotencyKey).toBe('regreport-failed:row-777:1');
      expect(recordFailure).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // resubmit
  // ==========================================================================

  describe('resubmit', () => {
    it('returns a not-found result when the row does not exist', async () => {
      findById.mockResolvedValue(null);

      const result = await service.resubmit(TENANT_ID, 'missing');

      expect(result.success).toBe(false);
      expect(result.feilmelding).toContain('not found');
      expect(submitByType).not.toHaveBeenCalled();
    });

    it('refuses to replay a non-REST (varsling) report type', async () => {
      findById.mockResolvedValue(makeRow({ reportType: RegulatoryReportType.ESCAPE }));

      const result = await service.resubmit(TENANT_ID, 'row-777');

      expect(result.success).toBe(false);
      expect(result.feilmelding).toContain('not a resubmittable REST report');
      expect(submitByType).not.toHaveBeenCalled();
    });

    it('re-validates the stored payload and replays via submitByType on success', async () => {
      findById.mockResolvedValue(makeRow({ payload: rawPayload }));
      submitByType.mockResolvedValue({ success: true, referanse: 'MT-9' });

      const result = await service.resubmit(TENANT_ID, 'row-777');

      expect(validate).toHaveBeenCalledWith(RegulatoryReportType.SEA_LICE, rawPayload);
      expect(submitByType).toHaveBeenCalledWith(
        TENANT_ID,
        RegulatoryReportType.SEA_LICE,
        rawPayload,
      );
      expect(result.success).toBe(true);
      expect(markSubmitted).toHaveBeenCalledWith(TENANT_ID, 'row-777', 'MT-9');
    });

    it('turns a now-schema-invalid stored payload into a PERMANENT failure, never a re-send', async () => {
      findById.mockResolvedValue(makeRow({ payload: rawPayload }));
      validate.mockImplementation(() => {
        throw new MattilsynetSchemaValidationError(RegulatoryReportType.SEA_LICE, [
          { felt: 'x', melding: 'y' },
        ]);
      });

      const result = await service.resubmit(TENANT_ID, 'row-777');

      expect(submitByType).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      // valideringsfeil → PERMANENT → applyFailure + outbox, no retry scheduled.
      expect(applyFailure).toHaveBeenCalledWith(
        mocks.mockManager,
        TENANT_ID,
        'row-777',
        expect.any(String),
        RegulatoryFailureClass.PERMANENT,
        null,
      );
      expect(recordFailure).not.toHaveBeenCalled();
    });
  });
});
