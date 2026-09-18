import { HealthEvent } from '../../entities/health-event.entity';
import { LiceCount } from '../../entities/lice-count.entity';
import { TreatmentApplication } from '../../entities/treatment-application.entity';
import { WelfareAssessment } from '../../entities/welfare-assessment.entity';
import type { HarvestEligibilityResult } from '../../services/batch-harvest-eligibility.service';
import {
  projectFishHealthStats,
  projectHarvestEligibility,
  projectHealthEvent,
  projectLiceCount,
  projectTreatmentApplication,
  projectWelfareAssessment,
} from '../projections';

const TENANT = '33333333-3333-4333-8333-333333333333';
const TANK = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const SITE = '44444444-4444-4444-8444-444444444444';

/** The PII ban list — none of these keys may appear anywhere in a reply. */
const BANNED_KEYS = [
  'reportedBy',
  'assignedTo',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'vet',
  'vetConsultation',
  'veterinarianWorkerId',
  'externalVetName',
  'recordedBy',
  'assessedBy',
  'countedBy',
  'measuredBy',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
  'description',
  'resolutionNotes',
  'beskrivelse',
  'symptoms',
  'treatment',
  'labResults',
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const FULL_EVENT = {
  id: 'he1',
  tenantId: TENANT,
  batchId: BATCH,
  tankId: TANK,
  title: 'Saprolegnia outbreak',
  description: 'clinical narrative',
  eventType: 'disease',
  severity: 'critical',
  status: 'active',
  diseaseCategory: 'fungal',
  diseaseName: 'Saprolegnia',
  eventDate: new Date('2026-09-01'),
  symptoms: { behavior: 'lethargy' },
  treatment: { method: 'bath' },
  labResults: { result: 'positive' },
  vetConsultation: { vet: 'Dr. Doe', userId: 'vet-user-id' },
  isUnderTreatment: true,
  isQuarantined: false,
  labConfirmed: false,
  vetNotified: true,
  withdrawalPeriodDays: 12,
  earliestHarvestDate: new Date('2026-09-20'),
  followUpRequired: true,
  nextFollowUpDate: new Date('2026-09-10'),
  reportedBy: 'operator-user-id',
  notes: 'operator note',
  attachments: ['https://bucket/photo.jpg'],
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as HealthEvent;

describe('fish-health farm-AI projections (PR-3 read-only namespace)', () => {
  it('strips PII, narrative blobs, and entity metadata — deep key scan', () => {
    const event = projectHealthEvent(FULL_EVENT);
    const lice = projectLiceCount({
      id: 'lc1',
      siteId: SITE,
      tankId: TANK,
      countedBy: 'operator-user-id',
      notes: 'operator note',
    } as LiceCount);
    const treatment = projectTreatmentApplication({
      id: 'ta1',
      siteId: SITE,
      category: 'medicinal',
      method: 'BADEBEHANDLING',
      wholeSite: false,
      appliedAt: new Date(),
      veterinarianWorkerId: 'worker-uuid',
      externalVetName: 'Dr. Doe',
      beskrivelse: 'free text',
      recordedBy: 'operator-user-id',
    } as TreatmentApplication);
    const welfare = projectWelfareAssessment({
      id: 'wa1',
      siteId: SITE,
      tankId: TANK,
      fishSampled: 20,
      gillScore: 1,
      finScore: 2,
      woundScore: 0,
      deformityScore: 0,
      assessedBy: 'operator-user-id',
      notes: 'operator note',
    } as WelfareAssessment);
    const eligibility = projectHarvestEligibility({
      eligible: false,
      blockedUntil: new Date('2026-09-20'),
      reason: 'withdrawal window open',
      blockingEvents: [
        {
          id: 'he1',
          title: 'Saprolegnia outbreak',
          diseaseName: 'Saprolegnia',
          earliestHarvestDate: new Date('2026-09-20'),
          withdrawalPeriodDays: 12,
          status: 'active',
        },
      ],
    } as HarvestEligibilityResult);
    const stats = projectFishHealthStats({
      total: 1,
      active: 1,
      critical: 1,
      underTreatment: 0,
      quarantined: 0,
      resolved: 0,
      byEventType: { disease: 1 },
      bySeverity: { critical: 1 },
    });

    for (const projection of [event, lice, treatment, welfare, eligibility, stats]) {
      const keys = collectKeys(projection);
      for (const banned of BANNED_KEYS) {
        expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
      }
      expect(keys.has('tenantId')).toBe(false);
      expect(keys.has('createdAt')).toBe(false);
      expect(keys.has('updatedAt')).toBe(false);
    }

    // no PII VALUES leak through either (even under an allowed key)
    const serialized = JSON.stringify([event, lice, treatment, welfare, eligibility]);
    expect(serialized).not.toContain('operator-user-id');
    expect(serialized).not.toContain('Dr. Doe');
    expect(serialized).not.toContain('vet-user-id');
    expect(serialized).not.toContain('photo.jpg');
    expect(serialized).not.toContain('operator note');
  });

  it('serializes every date as an ISO string (or null)', () => {
    const event = projectHealthEvent(FULL_EVENT);
    expect(event.eventDate).toBe('2026-09-01T00:00:00.000Z');
    expect(event.earliestHarvestDate).toBe('2026-09-20T00:00:00.000Z');
    expect(event.nextFollowUpDate).toBe('2026-09-10T00:00:00.000Z');

    const bare = projectHealthEvent({ ...FULL_EVENT, eventDate: null } as unknown as HealthEvent);
    expect(bare.eventDate).toBeNull();

    const lice = projectLiceCount({ countDate: '2026-09-07' } as LiceCount);
    expect(lice.countDate).toBe('2026-09-07T00:00:00.000Z');

    const treatment = projectTreatmentApplication({
      appliedAt: new Date('2026-09-01T08:00:00Z'),
      completedAt: undefined,
    } as TreatmentApplication);
    expect(treatment.appliedAt).toBe('2026-09-01T08:00:00.000Z');
    expect(treatment.completedAt).toBeNull();

    const welfare = projectWelfareAssessment({ assessedAt: '2026-09-05' } as WelfareAssessment);
    expect(welfare.assessedAt).toBe('2026-09-05T00:00:00.000Z');

    const eligibility = projectHarvestEligibility({ eligible: true, blockingEvents: [] });
    expect(eligibility.blockedUntil).toBeNull();
    expect(eligibility.reason).toBeNull();
    expect(eligibility.blockingEvents).toEqual([]);
  });

  it('keeps the clinical decision facts the persona needs', () => {
    const event = projectHealthEvent(FULL_EVENT);
    expect(event).toMatchObject({
      id: 'he1',
      batchId: BATCH,
      tankId: TANK,
      title: 'Saprolegnia outbreak',
      eventType: 'disease',
      severity: 'critical',
      status: 'active',
      diseaseName: 'Saprolegnia',
      withdrawalPeriodDays: 12,
      vetNotified: true,
      isUnderTreatment: true,
    });

    const treatment = projectTreatmentApplication({
      category: 'medicinal',
      method: 'BADEBEHANDLING',
      virkestoffType: 'AZAMETHIPHOS',
      styrkeVerdi: 100,
      styrkeEnhet: 'mg/kg',
      mengdeVerdi: 3.5,
      mengdeEnhet: 'kg',
      wholeSite: true,
      pensCount: 4,
    } as TreatmentApplication);
    expect(treatment).toMatchObject({
      category: 'medicinal',
      virkestoffType: 'AZAMETHIPHOS',
      styrkeVerdi: 100,
      mengdeVerdi: 3.5,
      wholeSite: true,
      pensCount: 4,
    });
  });
});
