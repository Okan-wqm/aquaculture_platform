import { ConfigService } from '@nestjs/config';

import {
  EmailService,
  FISKERIDIREKTORATET_EMAIL,
  MATTILSYNET_URGENT_EMAIL,
  RegulatoryReportEmailData,
} from '../email.service';

/**
 * Recipient-routing invariant for regulatory varsling emails.
 *
 * Norwegian akvakulturloven requires fish-escape ("romming") incidents to be
 * reported to BOTH Mattilsynet AND Fiskeridirektoratet, whereas welfare /
 * disease varsling go to Mattilsynet only. This test pins that routing so a
 * regression that drops Fiskeridirektoratet (or leaks it onto non-escape
 * reports) fails CI.
 *
 * nodemailer is module-mocked so the real EmailService transporter path runs
 * against a capturing transport — no private-field pokes, no casts.
 */

type SentMail = { to: string };

const sent: SentMail[] = [];

jest.mock('nodemailer', () => ({
  createTransport: (): { sendMail: (opts: { to: string }) => Promise<{ messageId: string }> } => ({
    sendMail: (opts: { to: string }): Promise<{ messageId: string }> => {
      sent.push({ to: opts.to });
      return Promise.resolve({ messageId: 'msg-test-1' });
    },
  }),
}));

function buildService(): EmailService {
  // Real ConfigService over an in-memory config — SMTP_ENABLED + SMTP_HOST
  // drive the constructor through the genuine initializeTransporter() path,
  // which calls the mocked nodemailer.createTransport above.
  const configService = new ConfigService({
    SMTP_ENABLED: 'true',
    SMTP_HOST: 'smtp.test.local',
    SMTP_PORT: 587,
    SMTP_FROM: 'noreply@aquaculture-platform.com',
  });
  return new EmailService(configService);
}

function baseData(): Omit<RegulatoryReportEmailData, 'reportType'> {
  return {
    siteName: 'North Site',
    siteCode: 'NS-01',
    lokalitetsnummer: '12345',
    organisasjonsnummer: '987654321',
    contactPerson: 'Ola Nordmann',
    contactEmail: 'ola@farm.no',
    contactPhone: '+4798989898',
    detectedAt: new Date('2026-06-14T08:00:00.000Z'),
    reportedBy: 'Ola Nordmann',
  };
}

describe('EmailService — regulatory varsling recipient routing', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('escape reports email BOTH Mattilsynet AND Fiskeridirektoratet', async () => {
    const service = buildService();

    const result = await service.sendEscapeReportEmail({
      ...baseData(),
      escapeData: {
        estimatedCount: 5000,
        species: 'Atlantic Salmon',
        avgWeightG: 3500,
        totalBiomassKg: 17500,
        cause: 'storm_damage',
        affectedUnits: ['Cage 3'],
        recoveryOngoing: true,
      },
    });

    expect(result.sentTo).toContain(MATTILSYNET_URGENT_EMAIL);
    expect(result.sentTo).toContain(FISKERIDIREKTORATET_EMAIL);

    // The header string handed to nodemailer must carry both addresses.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toContain(MATTILSYNET_URGENT_EMAIL);
    expect(sent[0]!.to).toContain(FISKERIDIREKTORATET_EMAIL);
  });

  it('welfare reports email Mattilsynet ONLY (no Fiskeridirektoratet)', async () => {
    const service = buildService();

    const result = await service.sendWelfareEventEmail({
      ...baseData(),
      welfareData: {
        eventType: 'mortality_threshold',
        severity: 'critical',
        mortalityRate: 6.2,
        mortalityPeriod: '1_day',
        description: 'Mortality threshold exceeded',
        immediateActions: ['Veterinarian consultation scheduled'],
      },
    });

    expect(result.sentTo).toContain(MATTILSYNET_URGENT_EMAIL);
    expect(result.sentTo).not.toContain(FISKERIDIREKTORATET_EMAIL);
    expect(sent[0]!.to).not.toContain(FISKERIDIREKTORATET_EMAIL);
  });

  it('disease reports email Mattilsynet ONLY (no Fiskeridirektoratet)', async () => {
    const service = buildService();

    const result = await service.sendDiseaseOutbreakEmail({
      ...baseData(),
      diseaseData: {
        diseaseCategory: 'C',
        diseaseName: 'Pancreas Disease',
        confirmation: 'confirmed',
        affectedCount: 2000,
        affectedPercentage: 15,
        clinicalSigns: ['lethargy'],
        veterinarianNotified: true,
        veterinarianName: 'Dr. Vet',
      },
    });

    expect(result.sentTo).toContain(MATTILSYNET_URGENT_EMAIL);
    expect(result.sentTo).not.toContain(FISKERIDIREKTORATET_EMAIL);
    expect(sent[0]!.to).not.toContain(FISKERIDIREKTORATET_EMAIL);
  });
});
