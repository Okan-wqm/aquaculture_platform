/**
 * RegulatoryReportStoreService — persistence lifecycle unit tests (FARM-HIGH-125).
 *
 * Locks the record-of-submission contract:
 *   - recordPending creates a PENDING row inside the tenant-pinned
 *     transaction boundary (modelled by createMockDataSource);
 *   - a resubmit with the same (reportType, klientReferanse) UPDATES the
 *     existing row (fresh payload, status back to PENDING, stale
 *     feilmelding cleared) instead of duplicating;
 *   - markSubmitted / recordFailure transition the row and populate
 *     referanse / feilmelding respectively;
 *   - recordQueued writes through the CALLER's EntityManager so the row
 *     commits atomically with the varsling outbox enqueue.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { AuditAction } from '../../database/entities/audit-log.entity';
import type { AuditLogService } from '../../database/services/audit-log.service';
import { RegulatoryReportStoreService } from '../services/regulatory-report-store.service';
import {
  RegulatoryFailureClass,
  RegulatoryReport,
  RegulatoryReportSubmissionStatus,
  RegulatoryReportType,
} from '../entities/regulatory-report.entity';
import type { SeaLicePayload } from '../mattilsynet-api.service';

const TENANT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

// The store persists the Mattilsynet WIRE payload for REST reports (Norwegian
// field names) — the exact bytes submitted, so the retry sweep can replay them.
const seaLicePayload: SeaLicePayload = {
  klientReferanse: 'ref-123',
  organisasjonsnummer: '987654321',
  lokalitetsnummer: 12345,
  kontaktperson: { navn: 'Ola', epost: 'ola@farm.no', telefonnummer: '+47' },
  rapporteringsår: 2026,
  rapporteringsuke: 26,
  sjøtemperatur: 12.5,
  lusetelling: { voksneHunnlus: 0.2, bevegeligeLus: 0.4, fastsittendeLus: 0.1 },
};

const baseParams = {
  reportType: RegulatoryReportType.SEA_LICE,
  klientReferanse: 'ref-123',
  siteId: 'site-1',
  lokalitetsnummer: 12345,
  reportYear: 2026,
  reportWeek: 26,
  payload: seaLicePayload,
  submittedBy: 'user-001',
};

describe('RegulatoryReportStoreService', () => {
  let service: RegulatoryReportStoreService;
  let mocks: ReturnType<typeof createMockDataSource>;
  let logWithManager: jest.Mock;

  beforeEach(() => {
    mocks = createMockDataSource();
    logWithManager = jest.fn().mockResolvedValue(undefined);
    const auditLog = {
      logWithManager,
    } as Partial<AuditLogService> as AuditLogService;
    service = new RegulatoryReportStoreService(mocks.mockDataSource, auditLog);
  });

  describe('recordPending', () => {
    it('creates a PENDING row when no submission exists for the client reference', async () => {
      const created = await service.recordPending(TENANT_ID, baseParams);

      expect(mocks.mockManager.findOne).toHaveBeenCalledWith(RegulatoryReport, {
        where: {
          tenantId: TENANT_ID,
          reportType: RegulatoryReportType.SEA_LICE,
          klientReferanse: 'ref-123',
        },
      });
      expect(created.status).toBe(RegulatoryReportSubmissionStatus.PENDING);
      expect(created.tenantId).toBe(TENANT_ID);
      expect(created.payload).toBe(seaLicePayload);
      expect(created.reportYear).toBe(2026);
      expect(created.reportWeek).toBe(26);
      expect(mocks.mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('updates the existing row on resubmit — fresh payload, PENDING again, stale error cleared', async () => {
      const existing = new RegulatoryReport();
      existing.id = 'row-1';
      existing.tenantId = TENANT_ID;
      existing.reportType = RegulatoryReportType.SEA_LICE;
      existing.klientReferanse = 'ref-123';
      existing.status = RegulatoryReportSubmissionStatus.FAILED;
      existing.feilmelding = 'previous failure';
      existing.referanse = 'MT-STALE-42';
      mocks.mockManager.findOne.mockResolvedValueOnce(existing);

      const row = await service.recordPending(TENANT_ID, baseParams);

      expect(mocks.mockManager.create).not.toHaveBeenCalled();
      expect(row.id).toBe('row-1');
      expect(row.status).toBe(RegulatoryReportSubmissionStatus.PENDING);
      expect(row.feilmelding).toBeNull();
      // FARM-LOW-133: a row re-entering PENDING carries no stale receipt.
      expect(row.referanse).toBeNull();
      expect(row.payload).toBe(seaLicePayload);
    });

    it('refuses to reset an already-SUBMITTED row — the accepted filing + receipt are immutable', async () => {
      // COMPLIANCE-HIGH-002: a re-entry for an accepted klientReferanse must not
      // resurrect the row to PENDING or drop its Mattilsynet receipt.
      const accepted = new RegulatoryReport();
      accepted.id = 'row-accepted';
      accepted.tenantId = TENANT_ID;
      accepted.reportType = RegulatoryReportType.SEA_LICE;
      accepted.klientReferanse = 'ref-123';
      accepted.status = RegulatoryReportSubmissionStatus.SUBMITTED;
      accepted.referanse = 'MT-ACCEPTED-7';
      mocks.mockManager.findOne.mockResolvedValueOnce(accepted);

      const row = await service.recordPending(TENANT_ID, baseParams);

      expect(row.status).toBe(RegulatoryReportSubmissionStatus.SUBMITTED);
      expect(row.referanse).toBe('MT-ACCEPTED-7');
      // returned as-is: no create, no save-mutation of the accepted row
      expect(mocks.mockManager.create).not.toHaveBeenCalled();
      expect(mocks.mockManager.save).not.toHaveBeenCalled();
    });
  });

  describe('findByKlientReferanse', () => {
    it('looks up the submission row by (tenantId, reportType, klientReferanse)', async () => {
      const existing = new RegulatoryReport();
      existing.id = 'row-1';
      mocks.mockManager.findOne.mockResolvedValueOnce(existing);

      const found = await service.findByKlientReferanse(
        TENANT_ID,
        RegulatoryReportType.SEA_LICE,
        'ref-123',
      );

      expect(found).toBe(existing);
      expect(mocks.mockManager.findOne).toHaveBeenCalledWith(RegulatoryReport, {
        where: {
          tenantId: TENANT_ID,
          reportType: RegulatoryReportType.SEA_LICE,
          klientReferanse: 'ref-123',
        },
      });
    });
  });

  describe('markSubmitted', () => {
    it('transitions to SUBMITTED, clears feilmelding, and closes the retry pipeline', async () => {
      const row = new RegulatoryReport();
      row.id = 'row-1';
      row.tenantId = TENANT_ID;
      row.status = RegulatoryReportSubmissionStatus.FAILED;
      row.feilmelding = 'stale';
      row.failureClass = RegulatoryFailureClass.TRANSIENT;
      row.nextAttemptAt = new Date('2026-07-06T10:00:00Z');
      (mocks.mockManager.findOneOrFail as jest.Mock) = jest.fn().mockResolvedValue(row);

      await service.markSubmitted(TENANT_ID, 'row-1', 'MT-REF-9');

      expect(row.status).toBe(RegulatoryReportSubmissionStatus.SUBMITTED);
      expect(row.referanse).toBe('MT-REF-9');
      expect(row.feilmelding).toBeNull();
      // A success closes the retry pipeline for this row.
      expect(row.nextAttemptAt).toBeNull();
      expect(row.failureClass).toBeNull();
      expect(row.submittedAt).toBeInstanceOf(Date);
      expect(mocks.mockManager.save).toHaveBeenCalledWith(RegulatoryReport, row);
      // COMPLIANCE-HIGH-001: the acceptance is audited inside the same txn.
      expect(logWithManager).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: AuditAction.REGULATORY_SUBMITTED,
          entityType: 'RegulatoryReport',
          entityId: 'row-1',
        }),
      );
    });
  });

  describe('recordFailure', () => {
    it('transitions to FAILED, increments attemptCount, and schedules the next replay', async () => {
      const row = new RegulatoryReport();
      row.id = 'row-1';
      row.tenantId = TENANT_ID;
      row.status = RegulatoryReportSubmissionStatus.PENDING;
      row.referanse = 'MT-STALE-9';
      row.attemptCount = 1;
      (mocks.mockManager.findOneOrFail as jest.Mock) = jest.fn().mockResolvedValue(row);
      const nextAttemptAt = new Date('2026-07-06T12:00:00Z');

      await service.recordFailure(
        TENANT_ID,
        'row-1',
        'Mattilsynet 502',
        RegulatoryFailureClass.TRANSIENT,
        nextAttemptAt,
      );

      expect(row.status).toBe(RegulatoryReportSubmissionStatus.FAILED);
      expect(row.feilmelding).toBe('Mattilsynet 502');
      // FARM-LOW-133: a failed submission has no valid receipt.
      expect(row.referanse).toBeNull();
      expect(row.attemptCount).toBe(2);
      expect(row.failureClass).toBe(RegulatoryFailureClass.TRANSIENT);
      expect(row.nextAttemptAt).toBe(nextAttemptAt);
      expect(mocks.mockManager.save).toHaveBeenCalledWith(RegulatoryReport, row);
    });
  });

  describe('applyFailure', () => {
    it('writes through the caller EntityManager (atomic with the outbox enqueue) for a PERMANENT failure', async () => {
      const row = new RegulatoryReport();
      row.id = 'row-1';
      row.tenantId = TENANT_ID;
      row.status = RegulatoryReportSubmissionStatus.PENDING;
      row.attemptCount = 0;
      (mocks.mockManager.findOneOrFail as jest.Mock) = jest.fn().mockResolvedValue(row);

      const saved = await service.applyFailure(
        mocks.mockManager,
        TENANT_ID,
        'row-1',
        'Invalid payload',
        RegulatoryFailureClass.PERMANENT,
        null,
      );

      // No transaction of its own — the caller owns the boundary.
      expect(mocks.mockDataSource.createQueryRunner).not.toHaveBeenCalled();
      expect(saved.status).toBe(RegulatoryReportSubmissionStatus.FAILED);
      expect(saved.failureClass).toBe(RegulatoryFailureClass.PERMANENT);
      expect(saved.nextAttemptAt).toBeNull();
      expect(saved.attemptCount).toBe(1);
      // COMPLIANCE-HIGH-001: the failure is audited on the caller's manager.
      expect(logWithManager).toHaveBeenCalledWith(
        mocks.mockManager,
        expect.objectContaining({
          action: AuditAction.REGULATORY_FAILED,
          entityType: 'RegulatoryReport',
          entityId: 'row-1',
        }),
      );
    });
  });

  describe('findById', () => {
    it('returns the row scoped to the tenant', async () => {
      const row = new RegulatoryReport();
      row.id = 'row-1';
      mocks.mockManager.findOne.mockResolvedValueOnce(row);

      const found = await service.findById(TENANT_ID, 'row-1');

      expect(found).toBe(row);
      expect(mocks.mockManager.findOne).toHaveBeenCalledWith(RegulatoryReport, {
        where: { id: 'row-1', tenantId: TENANT_ID },
      });
    });
  });

  describe('recordQueued', () => {
    it('writes through the caller-supplied EntityManager (atomic with the outbox enqueue)', async () => {
      const row = await service.recordQueued(
        mocks.mockManager,
        TENANT_ID,
        {
          reportType: RegulatoryReportType.ESCAPE,
          klientReferanse: 'ref-escape',
          siteId: 'site-1',
          lokalitetsnummer: 12345,
          payload: seaLicePayload,
          submittedBy: 'user-001',
        },
        'event-1',
      );

      // No transaction of its own — the caller owns the boundary.
      expect(mocks.mockDataSource.createQueryRunner).not.toHaveBeenCalled();
      expect(row.referanse).toBe('event-1');
      expect(row.submittedAt).toBeInstanceOf(Date);
      expect(row.status).toBe(RegulatoryReportSubmissionStatus.QUEUED);
      expect(row.klientReferanse).toBe('ref-escape');
      // COMPLIANCE-HIGH-001: the varsling filing is audited atomically with
      // the outbox enqueue on the caller's manager.
      expect(logWithManager).toHaveBeenCalledWith(
        mocks.mockManager,
        expect.objectContaining({
          action: AuditAction.REGULATORY_SUBMITTED,
          entityType: 'RegulatoryReport',
          userId: 'user-001',
        }),
      );
    });
  });
});
