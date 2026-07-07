/**
 * Golden payload fixtures for the five Mattilsynet REST report types.
 *
 * Typed against the payload interfaces in mattilsynet-api.service.ts and
 * validated against schemas/official/*.json by the contract spec — the
 * two-way drift trap: an interface change breaks compilation here, a schema
 * change breaks validation.
 */
import {
  SeaLicePayload,
  SmoltPayload,
  CleanerFishPayload,
  PlannedSlaughterPayload,
  ExecutedSlaughterPayload,
  KontaktpersonPayload,
} from '../../mattilsynet-api.service';

export const kontaktperson: KontaktpersonPayload = {
  navn: 'Kari Nordmann',
  epost: 'kari@oppdrett.no',
  telefonnummer: '+4791234567',
};

const base = {
  organisasjonsnummer: '987654321',
  lokalitetsnummer: 12345,
  kontaktperson,
};

export const seaLiceFixture: SeaLicePayload = {
  ...base,
  klientReferanse: 'b7f5b0f0-0000-4000-8000-000000000001',
  rapporteringsår: 2026,
  rapporteringsuke: 27,
  sjøtemperatur: 12.5,
  lusetelling: { voksneHunnlus: 0.12, bevegeligeLus: 0.4, fastsittendeLus: 0.05 },
  ikkeMedikamentelleBehandlinger: [
    {
      type: 'TERMISK_BEHANDLING',
      gjennomførtFørTelling: true,
      heleLokaliteten: false,
      antallMerder: 3,
    },
  ],
  medikamentelleBehandlinger: [
    {
      type: 'BADEBEHANDLING',
      gjennomførtFørTelling: false,
      heleLokaliteten: true,
      virkestoff: {
        type: 'AZAMETHIPHOS',
        styrke: { verdi: 0.5, enhet: 'PROSENT' },
        mengde: { verdi: 12, enhet: 'LITER' },
      },
    },
  ],
  kombinasjonsbehandlinger: [
    {
      ikkeMedikamentelleBehandlinger: [
        { type: 'FERSKVANNSBEHANDLING', gjennomførtFørTelling: false, heleLokaliteten: false },
      ],
      medikamentelleBehandlinger: [
        {
          type: 'FORBEHANDLING',
          gjennomførtFørTelling: false,
          heleLokaliteten: false,
          virkestoff: { type: 'HYDROGENPEROKSID' },
        },
      ],
    },
  ],
  resistensMistanker: [{ resistens: 'DELTAMETHRIN', årsak: 'NEDSATT_BEHANDLINGSEFFEKT' }],
  følsomhetsundersøkelser: [
    {
      utførtDato: '2026-06-28',
      laboratorium: 'PatoGen AS',
      resistens: 'DELTAMETHRIN',
      testresultat: 'NEDSATT_FØLSOMHET',
    },
  ],
};

export const smoltFixture: SmoltPayload = {
  ...base,
  klientReferanse: 'b7f5b0f0-0000-4000-8000-000000000002',
  rapporteringsmåned: 6,
  rapporteringsår: 2026,
  produksjonsenheter: [
    {
      karId: 'KAR-01',
      artskode: 'SAL',
      snittvektGram: 84.2,
      beholdningVedMånedsslutt: 120000,
      antallAvlivet: 350,
      antallSelvdød: 120,
      antallFlyttetEksternt: 0,
    },
  ],
};

export const cleanerFishFixture: CleanerFishPayload = {
  ...base,
  klientReferanse: 'b7f5b0f0-0000-4000-8000-000000000003',
  rapporteringsmåned: 6,
  rapporteringsår: 2026,
  samdriftOrganisasjonsnumre: ['912345678'],
  produksjonssyklusStart: '2026-04-01',
  tørrforKg: 120.5,
  våtforKg: 0,
  produksjonsenheter: [
    {
      merdId: 'MERD-03',
      arter: [
        {
          artskode: 'USB',
          opprinnelse: 'OPPDRETTET',
          beholdningVedForrigeMånedsslutt: 4200,
          utsett: { antallFlyttetInn: 0, antallNy: 500 },
          uttak: {
            antallAvlivetSykdom: 12,
            antallAvlivetSkader: 4,
            antallAvlivetAvmagret: 8,
            antallAvlivetForeståendeHåndteringAvLaksen: 0,
            antallAvlivetForeståendeUgunstigLevemiljø: 0,
            antallAvlivetSkalIkkeBrukes: 0,
            antallSelvdød: 30,
            antallFlyttetUt: 0,
            antallKanIkkeGjøresRedeFor: 15,
          },
        },
      ],
    },
  ],
};

export const plannedSlaughterFixture: PlannedSlaughterPayload = {
  ...base,
  klientReferanse: 'b7f5b0f0-0000-4000-8000-000000000004',
  uke: 29,
  år: 2026,
  godkjenningsnummer: 'S123',
  planlagteLokaliteter: [
    {
      organisasjonsnummer: '987654321',
      lokalitetsnummer: 12345,
      ukeplanPerArt: [{ artskode: 'SAL', mandagKg: 12000, torsdagKg: 8000 }],
    },
  ],
};

export const executedSlaughterFixture: ExecutedSlaughterPayload = {
  ...base,
  klientReferanse: 'b7f5b0f0-0000-4000-8000-000000000005',
  slakteuke: 27,
  slakteår: 2026,
  godkjenningsnummer: 'S123',
  utførteLokaliteter: [
    {
      organisasjonsnummer: '987654321',
      lokalitetsnummer: 12345,
      arter: [
        { art: 'SAL', superiorKg: 18000, ordinærKg: 2500, produksjonsfiskKg: 900, utkastKg: 40 },
      ],
    },
  ],
};
