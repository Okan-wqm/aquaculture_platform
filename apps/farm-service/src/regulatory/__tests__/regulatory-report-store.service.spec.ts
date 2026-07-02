/**
 * RegulatoryReportStoreService — persistence lifecycle unit tests (FARM-HIGH-112).
 *
 * Locks the record-of-submission contract:
 *   - recordPending creates a PENDING row inside the tenant-pinned
 *     transaction boundary (modelled by createMockDataSource);
 *   - a resubmit with the same (reportType, klientReferanse) UPDATES the
 *     existing row (fresh payload, status back to PENDING, stale
 *     feilmelding cleared) instead of duplicating;
 *   - markSubmitted / markFailed transition the row and populate
 *     referanse / feilmelding respectively;
 *   - recordQueued writes through the CALLER's EntityManager so the row
 *     commits atomically with the varsling outbox enqueue.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { RegulatoryReportStoreService } from '../services/regulatory-report-store.service';
import {
  RegulatoryReport,
  RegulatoryReportSubmissionStatus,
  RegulatoryReportType,
} from '../entities/regulatory-report.entity';
import type { SubmitSeaLiceReportInput } from '../dto/regulatory-inputs.dto';

const TENANT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

const seaLicePayload = {
  klientReferanse: 'ref-123',
  organisasjonsnummer: '987654321',
  lokalitetsnummer: 12345,
  kontaktperson: { navn: 'Ola', epost: 'ola@farm.no', telefonnummer: '+47' },
  rapporteringsaar: 2026,
  rapporteringsuke: 26,
  sjotemperatur: 12.5,
  lusetelling: { voksneHunnlus: 0.2, bevegeligeLus: 0.4, fastsittendeLus: 0.1 },
} as SubmitSeaLiceReportInput;

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

  beforeEach(() => {
    mocks = createMockDataSource();
    service = new RegulatoryReportStoreService(mocks.mockDataSource);
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
      mocks.mockManager.findOne.mockResolvedValueOnce(existing);

      const row = await service.recordPending(TENANT_ID, baseParams);

      expect(mocks.mockManager.create).not.toHaveBeenCalled();
      expect(row.id).toBe('row-1');
      expect(row.status).toBe(RegulatoryReportSubmissionStatus.PENDING);
      expect(row.feilmelding).toBeNull();
      expect(row.payload).toBe(seaLicePayload);
    });
  });

  describe('markSubmitted', () => {
    it('transitions to SUBMITTED with referanse and clears feilmelding', async () => {
      const row = new RegulatoryReport();
      row.id = 'row-1';
      row.tenantId = TENANT_ID;
      row.status = RegulatoryReportSubmissionStatus.PENDING;
      row.feilmelding = 'stale';
      (mocks.mockManager.findOneOrFail as jest.Mock) = jest.fn().mockResolvedValue(row);

      await service.markSubmitted(TENANT_ID, 'row-1', 'MT-REF-9');

      expect(row.status).toBe(RegulatoryReportSubmissionStatus.SUBMITTED);
      expect(row.referanse).toBe('MT-REF-9');
      expect(row.feilmelding).toBeNull();
      expect(row.submittedAt).toBeInstanceOf(Date);
      expect(mocks.mockManager.save).toHaveBeenCalledWith(RegulatoryReport, row);
    });
  });

  describe('markFailed', () => {
    it('transitions to FAILED and records the error message', async () => {
      const row = new RegulatoryReport();
      row.id = 'row-1';
      row.tenantId = TENANT_ID;
      row.status = RegulatoryReportSubmissionStatus.PENDING;
      (mocks.mockManager.findOneOrFail as jest.Mock) = jest.fn().mockResolvedValue(row);

      await service.markFailed(TENANT_ID, 'row-1', 'Mattilsynet 502');

      expect(row.status).toBe(RegulatoryReportSubmissionStatus.FAILED);
      expect(row.feilmelding).toBe('Mattilsynet 502');
      expect(mocks.mockManager.save).toHaveBeenCalledWith(RegulatoryReport, row);
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
    });
  });
});
