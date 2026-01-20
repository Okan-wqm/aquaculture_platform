/**
 * Mattilsynet API Client Service
 *
 * Client for submitting regulatory reports to the Norwegian Food Safety Authority
 * (Mattilsynet) aquaculture reporting API.
 *
 * API Documentation: https://innrapportering-api.fisk.mattilsynet.io/docs/
 *
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMAS
 *
 * Endpoints:
 * - POST /api/lakselus/v1/lakselus     - Sea lice reports
 * - POST /api/rensefisk/v1/rensefisk   - Cleaner fish reports
 * - POST /api/settefisk/v1/settefisk   - Smolt reports
 * - POST /api/slakt/v1/planlagt        - Planned slaughter reports
 * - POST /api/slakt/v1/utfort          - Executed slaughter reports
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaskinportenService, MATTILSYNET_SCOPES } from './maskinporten.service';
import { RegulatorySettingsService } from './regulatory-settings.service';

// ============================================================================
// Types - Common
// ============================================================================

/**
 * Contact person - Required for all Mattilsynet reports
 */
export interface KontaktpersonPayload {
  navn: string;
  epost: string;
  telefonnummer: string;
}

/**
 * Base interface for all Mattilsynet API requests
 * IMPORTANT: lokalitetsnummer is NUMBER not string
 */
export interface MattilsynetBasePayload {
  /** Client reference - unique identifier for the submission (UUID) */
  klientReferanse: string;
  /** Norwegian organization number (9 digits) */
  organisasjonsnummer: string;
  /** Site/Locality registration number (NUMBER!) */
  lokalitetsnummer: number;
  /** Contact person (required object) */
  kontaktperson: KontaktpersonPayload;
}

// ============================================================================
// Types - Sea Lice (Lakselus) - CORRECTED
// ============================================================================

export interface LusetellingPayload {
  voksneHunnlus: number;
  bevegeligeLus: number;
  fastsittendeLus: number;
}

export interface VirkestoffStyrkePayload {
  verdi: number;
  enhet: 'MILLIGRAM_PER_GRAM' | 'MILLIGRAM_PER_MILLILITER' | 'GRAM_PER_KILO' | 'MILLIGRAM_PER_KILO' | 'PROSENT';
}

export interface VirkestoffMengdePayload {
  verdi: number;
  enhet: 'GRAM' | 'KILO' | 'TONN' | 'LITER';
}

// Enum types aligned with official API
export type VirkestoffTypePayload =
  | 'AZAMETHIPHOS' | 'CYPERMETHRIN' | 'DELTAMETHRIN' | 'IMIDAKLOPRID'
  | 'HYDROGENPEROKSID' | 'DIFLUBENZURON' | 'EMAMECTIN_BENZOAT'
  | 'TEFLUBENZURON' | 'ANNET_VIRKESTOFF';

export type IkkeMedikamentellTypePayload =
  | 'TERMISK_BEHANDLING' | 'MEKANISK_BEHANDLING'
  | 'FERSKVANNSBEHANDLING' | 'ANNEN_BEHANDLING';

export type MedikamentellTypePayload =
  | 'FORBEHANDLING' | 'BADEBEHANDLING' | 'ANNEN_BEHANDLING';

export type ResistensTypePayload =
  | 'AZAMETHIPHOS' | 'CYPERMETHRIN' | 'DELTAMETHRIN' | 'IMIDAKLOPRID'
  | 'HYDROGENPEROKSID' | 'DIFLUBENZURON' | 'EMAMECTIN_BENZOAT'
  | 'TEFLUBENZURON' | 'FERSKVANNSBEHANDLING' | 'ANNEN_RESISTENS';

export type ResistensAarsakTypePayload =
  | 'BIOESSAY' | 'NEDSATT_BEHANDLINGSEFFEKT'
  | 'SITUASJONEN_I_OMRÅDET' | 'ANNEN_ÅRSAK';

export type TestresultatPayload = 'FØLSOM' | 'NEDSATT_FØLSOMHET' | 'RESISTENS';

export interface VirkestoffPayload {
  type: VirkestoffTypePayload;
  styrke?: VirkestoffStyrkePayload;
  mengde?: VirkestoffMengdePayload;
  annetVirkestoff?: string;
}

export interface IkkeMedikamentellBehandlingPayload {
  type: IkkeMedikamentellTypePayload;
  gjennomførtFørTelling: boolean;
  heleLokaliteten: boolean;
  antallMerder?: number;
  beskrivelse?: string;
}

export interface MedikamentellBehandlingPayload {
  type: MedikamentellTypePayload;
  gjennomførtFørTelling: boolean;
  heleLokaliteten: boolean;
  antallMerder?: number;
  virkestoff: VirkestoffPayload;
  /** Description - only set when type is 'ANNEN_BEHANDLING' */
  beskrivelse?: string;
}

/**
 * Combination treatment - ALIGNED WITH OFFICIAL KombinasjonsbehandlingDto
 * Contains arrays of both non-medicated and medicated treatments
 */
export interface KombinasjonsbehandlingPayload {
  ikkeMedikamentelleBehandlinger?: IkkeMedikamentellBehandlingPayload[];
  medikamentelleBehandlinger?: MedikamentellBehandlingPayload[];
}

/**
 * Resistance suspicion - ALIGNED WITH OFFICIAL MistankeOmResistensDto
 */
export interface ResistensMistankePayload {
  resistens: ResistensTypePayload;
  årsak: ResistensAarsakTypePayload;
  annenResistens?: string;
  annenÅrsak?: string;
}

export interface FølsomhetsundersøkelsePayload {
  utførtDato: string;
  laboratorium: string;
  resistens: ResistensTypePayload;
  testresultat: TestresultatPayload;
}

/**
 * Sea Lice Report Payload (Lakselus) - CORRECTED
 */
export interface SeaLicePayload extends MattilsynetBasePayload {
  /** Reporting year */
  rapporteringsår: number;
  /** Reporting week (1-53) */
  rapporteringsuke: number;
  /** Sea water temperature (Celsius) */
  sjøtemperatur: number;
  /** Lice counting data (single object, NOT array) */
  lusetelling: LusetellingPayload;
  /** Non-medicated treatments */
  ikkeMedikamentelleBehandlinger?: IkkeMedikamentellBehandlingPayload[];
  /** Medicated treatments */
  medikamentelleBehandlinger?: MedikamentellBehandlingPayload[];
  /** Combination treatments */
  kombinasjonsbehandlinger?: KombinasjonsbehandlingPayload[];
  /** Resistance suspicions */
  resistensMistanker?: ResistensMistankePayload[];
  /** Sensitivity test results */
  følsomhetsundersøkelser?: FølsomhetsundersøkelsePayload[];
}

// ============================================================================
// Types - Smolt (Settefisk) - CORRECTED
// ============================================================================

export interface ProduksjonsenhetSettefiskPayload {
  /** Tank/unit identifier */
  karId: string;
  /** Species code (e.g., SAL for salmon) */
  artskode: string;
  /** Average weight in grams */
  snittvektGram: number;
  /** Stock count at end of month */
  beholdningVedMånedsslutt: number;
  /** Number euthanized */
  antallAvlivet: number;
  /** Number died naturally */
  antallSelvdød: number;
  /** Number transferred externally */
  antallFlyttetEksternt: number;
}

/**
 * Smolt Report Payload (Settefisk) - CORRECTED
 */
export interface SmoltPayload extends MattilsynetBasePayload {
  /** Reporting month (1-12) */
  rapporteringsmåned: number;
  /** Reporting year */
  rapporteringsår: number;
  /** Production units data */
  produksjonsenheter: ProduksjonsenhetSettefiskPayload[];
}

// ============================================================================
// Types - Cleaner Fish (Rensefisk) - CORRECTED
// ============================================================================

export interface RensefiskUtsettPayload {
  antallFlyttetInn: number;
  antallNy: number;
}

export interface RensefiskUttakPayload {
  antallAvlivetSykdom: number;
  antallAvlivetSkader: number;
  antallAvlivetAvmagret: number;
  antallAvlivetForeståendeHåndteringAvLaksen: number;
  antallAvlivetForeståendeUgunstigLevemiljø: number;
  antallAvlivetSkalIkkeBrukes: number;
  antallSelvdød: number;
  antallFlyttetUt: number;
  antallKanIkkeGjøresRedeFor: number;
}

// Cleaner fish origin - ALIGNED WITH OFFICIAL RensefiskOpprinnelse
export type RensefiskOpprinnelsePayload =
  | 'UKJENT' | 'VILLFANGET' | 'OPPDRETTET' | 'VILLFANGET_OG_OPPDRETTET';

export interface RensefiskArtPayload {
  artskode: 'USB' | 'BER' | 'GRO' | 'BNB';
  opprinnelse: RensefiskOpprinnelsePayload;
  beholdningVedForrigeMånedsslutt: number;
  utsett: RensefiskUtsettPayload;
  uttak: RensefiskUttakPayload;
}

export interface ProduksjonsenhetRensefiskPayload {
  merdId: string;
  arter: RensefiskArtPayload[];
}

/**
 * Cleaner Fish Report Payload (Rensefisk) - CORRECTED
 */
export interface CleanerFishPayload extends MattilsynetBasePayload {
  /** Reporting month (1-12) */
  rapporteringsmåned: number;
  /** Reporting year */
  rapporteringsår: number;
  /** Co-operation organization numbers */
  samdriftOrganisasjonsnumre?: string[];
  /** Production cycle start date (ISO format) */
  produksjonssyklusStart?: string;
  /** Dry feed consumption (kg) */
  tørrforKg?: number;
  /** Wet feed consumption (kg) */
  våtforKg?: number;
  /** Production units (cages) with species data */
  produksjonsenheter: ProduksjonsenhetRensefiskPayload[];
}

// ============================================================================
// Types - Slaughter Reports - ALIGNED WITH OFFICIAL MATTILSYNET API
// ============================================================================

/**
 * Weekly plan per species - UkeplanPerArt
 * Contains planned slaughter amounts for each day of the week (gutted weight)
 */
export interface UkeplanPerArtPayload {
  artskode: string;
  mandagKg?: number;
  tirsdagKg?: number;
  onsdagKg?: number;
  torsdagKg?: number;
  fredagKg?: number;
  lørdagKg?: number;
  søndagKg?: number;
}

/**
 * Planned slaughter per locality - PlanlagtLokalitetDto
 */
export interface PlannedSlaughterLocalityPayload {
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  ukeplanPerArt: UkeplanPerArtPayload[];
}

/**
 * Planned Slaughter Report Payload (Planlagt Slakt) - CORRECTED
 */
export interface PlannedSlaughterPayload extends MattilsynetBasePayload {
  /** Week number (1-53) */
  uke: number;
  /** Year */
  år: number;
  /** Slaughter facility approval number */
  godkjenningsnummer: string;
  /** Planned slaughters by locality */
  planlagteLokaliteter: PlannedSlaughterLocalityPayload[];
}

/**
 * Quality grades per species - KvalitetsklasserPerArt
 * Contains slaughter amounts by quality grade (gutted weight)
 */
export interface KvalitetsklasserPerArtPayload {
  art: string;
  superiorKg: number;
  ordinærKg: number;
  produksjonsfiskKg: number;
  utkastKg: number;
}

/**
 * Executed slaughter per locality - UtførtSlaktDto
 */
export interface ExecutedSlaughterLocalityPayload {
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  arter: KvalitetsklasserPerArtPayload[];
}

/**
 * Executed Slaughter Report Payload (Utført Slakt) - CORRECTED
 */
export interface ExecutedSlaughterPayload extends MattilsynetBasePayload {
  /** Slaughter week number (1-53) */
  slakteuke: number;
  /** Slaughter year */
  slakteår: number;
  /** Slaughter facility approval number */
  godkjenningsnummer: string;
  /** Executed slaughters by locality */
  utførteLokaliteter: ExecutedSlaughterLocalityPayload[];
}

/**
 * API Response from Mattilsynet
 */
export interface MattilsynetApiResponse {
  /** Success status */
  success: boolean;
  /** Mattilsynet reference number (if successful) */
  referanse?: string;
  /** Client reference echoed back */
  klientReferanse?: string;
  /** Error message (if failed) */
  feilmelding?: string;
  /** Validation errors (if any) */
  valideringsfeil?: {
    felt: string;
    melding: string;
  }[];
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class MattilsynetApiService {
  private readonly logger = new Logger(MattilsynetApiService.name);
  private readonly baseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly maskinporten: MaskinportenService,
    @Inject(forwardRef(() => RegulatorySettingsService))
    private readonly settingsService: RegulatorySettingsService,
  ) {
    // Default to test environment
    const environment = this.configService.get<string>('MATTILSYNET_ENV', 'TEST');
    this.baseUrl = environment === 'PRODUCTION'
      ? 'https://innrapportering-api.fisk.mattilsynet.io'
      : 'https://innrapportering-api.fisk-dev.mattilsynet.io';

    this.logger.log(`Mattilsynet API configured for: ${this.baseUrl}`);
  }

  /**
   * Get headers for API requests
   */
  private async getHeaders(tenantId: string, scope: string): Promise<Record<string, string>> {
    const token = await this.maskinporten.getAccessToken(tenantId, [scope]);
    const clientId = await this.settingsService.getDecryptedClientId(tenantId) || '';

    return {
      'Authorization': `Bearer ${token}`,
      'Client-Id': clientId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  /**
   * Submit a Sea Lice report
   * POST /api/lakselus/v1/lakselus
   */
  async submitSeaLiceReport(tenantId: string, payload: SeaLicePayload): Promise<MattilsynetApiResponse> {
    const endpoint = `${this.baseUrl}/api/lakselus/v1/lakselus`;
    return this.submitReport(tenantId, endpoint, payload, MATTILSYNET_SCOPES.SEA_LICE, 'Sea Lice');
  }

  /**
   * Submit a Cleaner Fish report
   * POST /api/rensefisk/v1/rensefisk
   */
  async submitCleanerFishReport(tenantId: string, payload: CleanerFishPayload): Promise<MattilsynetApiResponse> {
    const endpoint = `${this.baseUrl}/api/rensefisk/v1/rensefisk`;
    return this.submitReport(tenantId, endpoint, payload, MATTILSYNET_SCOPES.CLEANER_FISH, 'Cleaner Fish');
  }

  /**
   * Submit a Smolt report
   * POST /api/settefisk/v1/settefisk
   */
  async submitSmoltReport(tenantId: string, payload: SmoltPayload): Promise<MattilsynetApiResponse> {
    const endpoint = `${this.baseUrl}/api/settefisk/v1/settefisk`;
    return this.submitReport(tenantId, endpoint, payload, MATTILSYNET_SCOPES.SMOLT, 'Smolt');
  }

  /**
   * Submit a Planned Slaughter report
   * POST /api/slakt/v1/planlagt
   */
  async submitPlannedSlaughterReport(tenantId: string, payload: PlannedSlaughterPayload): Promise<MattilsynetApiResponse> {
    const endpoint = `${this.baseUrl}/api/slakt/v1/planlagt`;
    return this.submitReport(tenantId, endpoint, payload, MATTILSYNET_SCOPES.SLAUGHTER, 'Planned Slaughter');
  }

  /**
   * Submit an Executed Slaughter report
   * POST /api/slakt/v1/utfort
   */
  async submitExecutedSlaughterReport(tenantId: string, payload: ExecutedSlaughterPayload): Promise<MattilsynetApiResponse> {
    const endpoint = `${this.baseUrl}/api/slakt/v1/utfort`;
    return this.submitReport(tenantId, endpoint, payload, MATTILSYNET_SCOPES.SLAUGHTER, 'Executed Slaughter');
  }

  /**
   * Generic report submission handler
   */
  private async submitReport(
    tenantId: string,
    endpoint: string,
    payload: MattilsynetBasePayload,
    scope: string,
    reportType: string,
  ): Promise<MattilsynetApiResponse> {
    this.logger.log(`Submitting ${reportType} report: ${payload.klientReferanse}`);

    try {
      const headers = await this.getHeaders(tenantId, scope);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const responseData = await response.json();

      if (!response.ok) {
        this.logger.error(
          `${reportType} report submission failed: ${response.status}`,
          responseData,
        );

        return {
          success: false,
          klientReferanse: payload.klientReferanse,
          feilmelding: responseData.message || `HTTP ${response.status}`,
          valideringsfeil: responseData.errors || responseData.validationErrors,
        };
      }

      this.logger.log(
        `${reportType} report submitted successfully: ${responseData.referanse || 'OK'}`,
      );

      return {
        success: true,
        referanse: responseData.referanse || responseData.id,
        klientReferanse: payload.klientReferanse,
      };
    } catch (error) {
      this.logger.error(`Failed to submit ${reportType} report: ${error}`);

      return {
        success: false,
        klientReferanse: payload.klientReferanse,
        feilmelding: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Check API health/connectivity for a tenant
   */
  async healthCheck(tenantId: string): Promise<{ healthy: boolean; message: string }> {
    try {
      // Try to get a token (validates Maskinporten connection)
      if (!await this.maskinporten.isConfiguredForTenant(tenantId)) {
        return {
          healthy: false,
          message: 'Maskinporten not configured',
        };
      }

      // Note: Mattilsynet API doesn't have a public health endpoint
      // This just validates that we can get a token
      await this.maskinporten.getAllMattilsynetToken(tenantId);

      return {
        healthy: true,
        message: `Connected to ${this.baseUrl}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  /**
   * Get service status for a tenant
   */
  async getStatus(tenantId: string): Promise<{
    baseUrl: string;
    environment: string;
    maskinportenConfigured: boolean;
  }> {
    return {
      baseUrl: this.baseUrl,
      environment: this.configService.get<string>('MATTILSYNET_ENV', 'TEST'),
      maskinportenConfigured: await this.maskinporten.isConfiguredForTenant(tenantId),
    };
  }

  /**
   * Get service status (without tenant - for health checks)
   */
  getGlobalStatus(): {
    baseUrl: string;
    environment: string;
  } {
    return {
      baseUrl: this.baseUrl,
      environment: this.configService.get<string>('MATTILSYNET_ENV', 'TEST'),
    };
  }
}
