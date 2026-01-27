/**
 * Regulatory Reports Resolver
 *
 * GraphQL resolvers for:
 * 1. Tenant regulatory settings management (company info, Maskinporten credentials)
 * 2. Submitting regulatory reports to Mattilsynet
 *
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMAS.
 *
 * @module Regulatory/Resolvers
 */
import { Resolver, Mutation, Query, Args, Context } from '@nestjs/graphql';
import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  MattilsynetApiService,
  SeaLicePayload,
  SmoltPayload,
  CleanerFishPayload,
  PlannedSlaughterPayload,
  ExecutedSlaughterPayload,
  IkkeMedikamentellTypePayload,
  MedikamentellTypePayload,
  VirkestoffTypePayload,
  VirkestoffStyrkePayload,
  VirkestoffMengdePayload,
  ResistensTypePayload,
  ResistensAarsakTypePayload,
  TestresultatPayload,
  RensefiskOpprinnelsePayload,
} from './mattilsynet-api.service';
import { MaskinportenService, MATTILSYNET_SCOPES } from './maskinporten.service';
import { RegulatorySettingsService } from './regulatory-settings.service';
import {
  SubmitSeaLiceReportInput,
  SubmitCleanerFishReportInput,
  SubmitSmoltReportInput,
  SubmitPlannedSlaughterInput,
  SubmitExecutedSlaughterInput,
  ReportSubmissionResult,
} from './dto/regulatory-inputs.dto';
import {
  RegulatorySettingsOutput,
  UpdateRegulatorySettingsInput,
  MaskinportenConnectionTestResult,
  RegulatoryConfigurationStatus,
  SiteLocalityMappingOutput,
} from './dto/regulatory-settings.dto';
import { ObjectType, Field } from '@nestjs/graphql';

/**
 * GraphQL context interface with request and user information
 */
interface GraphQLContext {
  req?: {
    user?: {
      tenantId?: string;
      sub?: string;
    };
    tenantId?: string;
  };
}

// ============================================================================
// Status Types
// ============================================================================

@ObjectType()
class MaskinportenStatus {
  @Field()
  configured: boolean;

  @Field()
  environment: string;

  @Field(() => [String])
  scopes: string[];

  @Field({ nullable: true })
  tokenEndpoint?: string;
}

@ObjectType()
class MattilsynetStatus {
  @Field()
  baseUrl: string;

  @Field()
  environment: string;

  @Field()
  maskinportenConfigured: boolean;
}

@ObjectType()
class RegulatoryHealthStatus {
  @Field()
  maskinportenHealthy: boolean;

  @Field()
  mattilsynetHealthy: boolean;

  @Field({ nullable: true })
  message?: string;
}

// ============================================================================
// Resolver
// ============================================================================

@Resolver()
export class RegulatoryResolver {
  private readonly logger = new Logger(RegulatoryResolver.name);

  constructor(
    private readonly mattilsynetApi: MattilsynetApiService,
    private readonly maskinporten: MaskinportenService,
    private readonly settingsService: RegulatorySettingsService,
  ) {}

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Extract tenant ID from GraphQL context
   */
  private getTenantId(ctx: GraphQLContext): string {
    const tenantId = ctx?.req?.user?.tenantId || ctx?.req?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant context required');
    }
    return tenantId;
  }

  /**
   * Map entity to GraphQL output
   */
  private async mapSettingsToOutput(tenantId: string): Promise<RegulatorySettingsOutput> {
    const settings = await this.settingsService.getSettings(tenantId);
    const maskedClientId = await this.settingsService.getMaskedClientId(tenantId);

    if (!settings) {
      return {
        maskinportenConfigured: false,
        siteLocalityMappings: [],
      };
    }

    // Transform siteLocalityMappings to array format
    const mappingsArray: SiteLocalityMappingOutput[] = Object.entries(
      settings.siteLocalityMappings || {},
    ).map(([siteId, lokalitetsnummer]) => ({
      siteId,
      lokalitetsnummer,
    }));

    return {
      id: settings.id,
      companyName: settings.companyName,
      organisationNumber: settings.organisationNumber,
      companyAddress: settings.companyAddress,
      maskinportenConfigured: !!(
        settings.maskinportenClientId &&
        settings.maskinportenPrivateKeyEncrypted
      ),
      maskinportenEnvironment: settings.maskinportenEnvironment,
      maskinportenClientIdMasked: maskedClientId || undefined,
      maskinportenKeyId: settings.maskinportenKeyId,
      defaultContactName: settings.defaultContactName,
      defaultContactEmail: settings.defaultContactEmail,
      defaultContactPhone: settings.defaultContactPhone,
      siteLocalityMappings: mappingsArray,
      slaughterApprovalNumber: settings.slaughterApprovalNumber,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    };
  }

  // ==========================================================================
  // Queries - Regulatory Settings
  // ==========================================================================

  /**
   * Get regulatory settings for current tenant
   */
  @Query(() => RegulatorySettingsOutput, {
    description: 'Get regulatory settings for the current tenant',
  })
  async regulatorySettings(@Context() ctx: GraphQLContext): Promise<RegulatorySettingsOutput> {
    const tenantId = this.getTenantId(ctx);
    this.logger.debug(`Getting regulatory settings for tenant: ${tenantId}`);
    return this.mapSettingsToOutput(tenantId);
  }

  /**
   * Get regulatory configuration status for current tenant
   */
  @Query(() => RegulatoryConfigurationStatus, {
    description: 'Get regulatory configuration status for the current tenant',
  })
  async regulatoryConfigurationStatus(@Context() ctx: GraphQLContext): Promise<RegulatoryConfigurationStatus> {
    const tenantId = this.getTenantId(ctx);
    const settings = await this.settingsService.getSettings(tenantId);

    const hasCompanyInfo = !!(settings?.companyName && settings?.organisationNumber);
    const hasMaskinportenCredentials = !!(
      settings?.maskinportenClientId &&
      settings?.maskinportenPrivateKeyEncrypted
    );
    const hasDefaultContact = !!(
      settings?.defaultContactName &&
      settings?.defaultContactEmail
    );
    const siteMappingsCount = Object.keys(settings?.siteLocalityMappings || {}).length;
    const hasSlaughterApproval = !!settings?.slaughterApprovalNumber;

    return {
      hasCompanyInfo,
      hasMaskinportenCredentials,
      hasDefaultContact,
      siteMappingsCount,
      hasSlaughterApproval,
      isFullyConfigured:
        hasCompanyInfo &&
        hasMaskinportenCredentials &&
        hasDefaultContact &&
        siteMappingsCount > 0,
    };
  }

  // ==========================================================================
  // Mutations - Regulatory Settings
  // ==========================================================================

  /**
   * Update regulatory settings for current tenant
   */
  @Mutation(() => RegulatorySettingsOutput, {
    description: 'Update regulatory settings for the current tenant',
  })
  async updateRegulatorySettings(
    @Args('input') input: UpdateRegulatorySettingsInput,
    @Context() ctx: GraphQLContext,
  ): Promise<RegulatorySettingsOutput> {
    const tenantId = this.getTenantId(ctx);
    this.logger.log(`Updating regulatory settings for tenant: ${tenantId}`);

    // Transform site mappings from array to object
    let mappings: Record<string, number> | undefined;
    if (input.siteLocalityMappings) {
      mappings = input.siteLocalityMappings.reduce(
        (acc, m) => {
          acc[m.siteId] = m.lokalitetsnummer;
          return acc;
        },
        {} as Record<string, number>,
      );
    }

    await this.settingsService.saveSettings(tenantId, {
      companyName: input.companyName,
      organisationNumber: input.organisationNumber,
      companyAddress: input.companyAddress,
      maskinportenClientId: input.maskinportenClientId,
      maskinportenPrivateKey: input.maskinportenPrivateKey,
      maskinportenKeyId: input.maskinportenKeyId,
      maskinportenEnvironment: input.maskinportenEnvironment,
      defaultContactName: input.defaultContactName,
      defaultContactEmail: input.defaultContactEmail,
      defaultContactPhone: input.defaultContactPhone,
      siteLocalityMappings: mappings,
      slaughterApprovalNumber: input.slaughterApprovalNumber,
    });

    return this.mapSettingsToOutput(tenantId);
  }

  /**
   * Test Maskinporten connection with tenant credentials
   */
  @Mutation(() => MaskinportenConnectionTestResult, {
    description: 'Test Maskinporten connection using tenant credentials',
  })
  async testMaskinportenConnection(
    @Context() ctx: GraphQLContext,
  ): Promise<MaskinportenConnectionTestResult> {
    const tenantId = this.getTenantId(ctx);
    this.logger.log(`Testing Maskinporten connection for tenant: ${tenantId}`);

    try {
      // Check if credentials are configured
      const isConfigured = await this.settingsService.isConfigured(tenantId);
      if (!isConfigured) {
        return {
          success: false,
          error: 'Maskinporten credentials not configured. Please configure client ID and private key first.',
        };
      }

      // Try to get a token
      const token = await this.maskinporten.getAccessToken(tenantId, [
        MATTILSYNET_SCOPES.SEA_LICE,
      ]);

      if (token) {
        return {
          success: true,
          message: 'Maskinporten connection successful',
          scopes: [MATTILSYNET_SCOPES.SEA_LICE],
        };
      }

      return {
        success: false,
        error: 'Failed to obtain access token',
      };
    } catch (error) {
      this.logger.error(`Maskinporten connection test failed: ${error}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection test failed',
      };
    }
  }

  // ==========================================================================
  // Queries - Service Status (Legacy)
  // ==========================================================================

  /**
   * Get Maskinporten configuration status
   */
  @Query(() => MaskinportenStatus, { description: 'Get Maskinporten configuration status' })
  async maskinportenStatus(): Promise<MaskinportenStatus> {
    return this.maskinporten.getStatus();
  }

  /**
   * Get Mattilsynet API configuration status
   */
  @Query(() => MattilsynetStatus, { description: 'Get Mattilsynet API configuration status' })
  async mattilsynetStatus(@Context() ctx: GraphQLContext): Promise<MattilsynetStatus> {
    const tenantId = this.getTenantId(ctx);
    return this.mattilsynetApi.getStatus(tenantId);
  }

  /**
   * Check regulatory services health
   */
  @Query(() => RegulatoryHealthStatus, { description: 'Check regulatory services health' })
  async regulatoryHealth(@Context() ctx: GraphQLContext): Promise<RegulatoryHealthStatus> {
    const tenantId = this.getTenantId(ctx);
    const maskinportenHealthy = await this.maskinporten.isConfiguredForTenant(tenantId);
    const mattilsynetCheck = await this.mattilsynetApi.healthCheck(tenantId);

    return {
      maskinportenHealthy,
      mattilsynetHealthy: mattilsynetCheck.healthy,
      message: mattilsynetCheck.message,
    };
  }

  // ==========================================================================
  // Mutations - Mattilsynet API Reports
  // ==========================================================================

  /**
   * Submit a Sea Lice report to Mattilsynet
   * POST /api/lakselus/v1/lakselus
   */
  @Mutation(() => ReportSubmissionResult, { description: 'Submit Sea Lice report to Mattilsynet' })
  async submitSeaLiceReport(
    @Args('input') input: SubmitSeaLiceReportInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    this.logger.log(`Submitting Sea Lice report: ${input.klientReferanse}`);

    try {
      // Transform GraphQL input to API payload
      const payload: SeaLicePayload = {
        klientReferanse: input.klientReferanse,
        organisasjonsnummer: input.organisasjonsnummer,
        lokalitetsnummer: input.lokalitetsnummer,
        kontaktperson: {
          navn: input.kontaktperson.navn,
          epost: input.kontaktperson.epost,
          telefonnummer: input.kontaktperson.telefonnummer,
        },
        rapporteringsår: input.rapporteringsaar,
        rapporteringsuke: input.rapporteringsuke,
        sjøtemperatur: input.sjotemperatur,
        lusetelling: {
          voksneHunnlus: input.lusetelling.voksneHunnlus,
          bevegeligeLus: input.lusetelling.bevegeligeLus,
          fastsittendeLus: input.lusetelling.fastsittendeLus,
        },
        ikkeMedikamentelleBehandlinger: input.ikkeMedikamentelleBehandlinger?.map(b => ({
          type: b.type as IkkeMedikamentellTypePayload,
          gjennomførtFørTelling: b.gjennomfortForTelling,
          heleLokaliteten: b.heleLokaliteten,
          antallMerder: b.antallMerder,
          beskrivelse: b.beskrivelse,
        })),
        medikamentelleBehandlinger: input.medikamentelleBehandlinger?.map(b => ({
          type: b.type as MedikamentellTypePayload,
          gjennomførtFørTelling: b.gjennomfortForTelling,
          heleLokaliteten: b.heleLokaliteten,
          antallMerder: b.antallMerder,
          virkestoff: {
            type: b.virkestoff.type as VirkestoffTypePayload,
            styrke: b.virkestoff.styrke ? {
              verdi: b.virkestoff.styrke.verdi,
              enhet: b.virkestoff.styrke.enhet as VirkestoffStyrkePayload['enhet'],
            } : undefined,
            mengde: b.virkestoff.mengde ? {
              verdi: b.virkestoff.mengde.verdi,
              enhet: b.virkestoff.mengde.enhet as VirkestoffMengdePayload['enhet'],
            } : undefined,
            annetVirkestoff: b.virkestoff.annetVirkestoff,
          },
          beskrivelse: b.beskrivelse,
        })),
        // Combination treatments - ALIGNED WITH OFFICIAL KombinasjonsbehandlingDto
        kombinasjonsbehandlinger: input.kombinasjonsbehandlinger?.map(k => ({
          ikkeMedikamentelleBehandlinger: k.ikkeMedikamentelleBehandlinger?.map(b => ({
            type: b.type as IkkeMedikamentellTypePayload,
            gjennomførtFørTelling: b.gjennomfortForTelling,
            heleLokaliteten: b.heleLokaliteten,
            antallMerder: b.antallMerder,
            beskrivelse: b.beskrivelse,
          })),
          medikamentelleBehandlinger: k.medikamentelleBehandlinger?.map(b => ({
            type: b.type as MedikamentellTypePayload,
            gjennomførtFørTelling: b.gjennomfortForTelling,
            heleLokaliteten: b.heleLokaliteten,
            antallMerder: b.antallMerder,
            virkestoff: {
              type: b.virkestoff.type as VirkestoffTypePayload,
              styrke: b.virkestoff.styrke ? {
                verdi: b.virkestoff.styrke.verdi,
                enhet: b.virkestoff.styrke.enhet as VirkestoffStyrkePayload['enhet'],
              } : undefined,
              mengde: b.virkestoff.mengde ? {
                verdi: b.virkestoff.mengde.verdi,
                enhet: b.virkestoff.mengde.enhet as VirkestoffMengdePayload['enhet'],
              } : undefined,
              annetVirkestoff: b.virkestoff.annetVirkestoff,
            },
            beskrivelse: b.beskrivelse,
          })),
        })),
        // Resistance suspicions - ALIGNED WITH OFFICIAL MistankeOmResistensDto
        resistensMistanker: input.resistensMistanker?.map(r => ({
          resistens: r.resistens as ResistensTypePayload,
          årsak: r.aarsak as ResistensAarsakTypePayload,
          annenResistens: r.annenResistens,
          annenÅrsak: r.annenAarsak,
        })),
        følsomhetsundersøkelser: input.folsomhetsundersokelser?.map(f => ({
          utførtDato: f.utfortDato,
          laboratorium: f.laboratorium,
          resistens: f.resistens as ResistensTypePayload,
          testresultat: f.testresultat as TestresultatPayload,
        })),
      };

      const result = await this.mattilsynetApi.submitSeaLiceReport(tenantId, payload);
      return result;
    } catch (error) {
      this.logger.error(`Failed to submit Sea Lice report: ${error}`);
      return {
        success: false,
        klientReferanse: input.klientReferanse,
        feilmelding: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Submit a Cleaner Fish report to Mattilsynet
   * POST /api/rensefisk/v1/rensefisk
   */
  @Mutation(() => ReportSubmissionResult, { description: 'Submit Cleaner Fish report to Mattilsynet' })
  async submitCleanerFishReport(
    @Args('input') input: SubmitCleanerFishReportInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    this.logger.log(`Submitting Cleaner Fish report: ${input.klientReferanse}`);

    try {
      // Transform GraphQL input to API payload
      const payload: CleanerFishPayload = {
        klientReferanse: input.klientReferanse,
        organisasjonsnummer: input.organisasjonsnummer,
        lokalitetsnummer: input.lokalitetsnummer,
        kontaktperson: {
          navn: input.kontaktperson.navn,
          epost: input.kontaktperson.epost,
          telefonnummer: input.kontaktperson.telefonnummer,
        },
        rapporteringsmåned: input.rapporteringsmaaned,
        rapporteringsår: input.rapporteringsaar,
        samdriftOrganisasjonsnumre: input.samdriftOrganisasjonsnumre,
        produksjonssyklusStart: input.produksjonssyklusStart,
        tørrforKg: input.torrforKg,
        våtforKg: input.vatforKg,
        produksjonsenheter: input.produksjonsenheter.map(p => ({
          merdId: p.merdId,
          arter: p.arter.map(a => ({
            artskode: a.artskode as 'USB' | 'BER' | 'GRO' | 'BNB',
            opprinnelse: a.opprinnelse as RensefiskOpprinnelsePayload,
            beholdningVedForrigeMånedsslutt: a.beholdningVedForrigeMaanedsslutt,
            utsett: {
              antallFlyttetInn: a.utsett.antallFlyttetInn,
              antallNy: a.utsett.antallNy,
            },
            uttak: {
              antallAvlivetSykdom: a.uttak.antallAvlivetSykdom,
              antallAvlivetSkader: a.uttak.antallAvlivetSkader,
              antallAvlivetAvmagret: a.uttak.antallAvlivetAvmagret,
              antallAvlivetForeståendeHåndteringAvLaksen: a.uttak.antallAvlivetForestaendeHaandteringAvLaksen,
              antallAvlivetForeståendeUgunstigLevemiljø: a.uttak.antallAvlivetForestaendeUgunstigLevemiljo,
              antallAvlivetSkalIkkeBrukes: a.uttak.antallAvlivetSkalIkkeBrukes,
              antallSelvdød: a.uttak.antallSelvdod,
              antallFlyttetUt: a.uttak.antallFlyttetUt,
              antallKanIkkeGjøresRedeFor: a.uttak.antallKanIkkeGjoresRedeFor,
            },
          })),
        })),
      };

      const result = await this.mattilsynetApi.submitCleanerFishReport(tenantId, payload);
      return result;
    } catch (error) {
      this.logger.error(`Failed to submit Cleaner Fish report: ${error}`);
      return {
        success: false,
        klientReferanse: input.klientReferanse,
        feilmelding: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Submit a Smolt report to Mattilsynet
   * POST /api/settefisk/v1/settefisk
   */
  @Mutation(() => ReportSubmissionResult, { description: 'Submit Smolt report to Mattilsynet' })
  async submitSmoltReport(
    @Args('input') input: SubmitSmoltReportInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    this.logger.log(`Submitting Smolt report: ${input.klientReferanse}`);

    try {
      // Transform GraphQL input to API payload
      const payload: SmoltPayload = {
        klientReferanse: input.klientReferanse,
        organisasjonsnummer: input.organisasjonsnummer,
        lokalitetsnummer: input.lokalitetsnummer,
        kontaktperson: {
          navn: input.kontaktperson.navn,
          epost: input.kontaktperson.epost,
          telefonnummer: input.kontaktperson.telefonnummer,
        },
        rapporteringsmåned: input.rapporteringsmaaned,
        rapporteringsår: input.rapporteringsaar,
        produksjonsenheter: input.produksjonsenheter.map(p => ({
          karId: p.karId,
          artskode: p.artskode,
          snittvektGram: p.snittvektGram,
          beholdningVedMånedsslutt: p.beholdningVedMaanedsslutt,
          antallAvlivet: p.antallAvlivet,
          antallSelvdød: p.antallSelvdod,
          antallFlyttetEksternt: p.antallFlyttetEksternt,
        })),
      };

      const result = await this.mattilsynetApi.submitSmoltReport(tenantId, payload);
      return result;
    } catch (error) {
      this.logger.error(`Failed to submit Smolt report: ${error}`);
      return {
        success: false,
        klientReferanse: input.klientReferanse,
        feilmelding: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Submit a Planned Slaughter report to Mattilsynet
   * POST /api/slakt/v1/planlagt
   */
  @Mutation(() => ReportSubmissionResult, { description: 'Submit Planned Slaughter report to Mattilsynet' })
  async submitPlannedSlaughterReport(
    @Args('input') input: SubmitPlannedSlaughterInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    this.logger.log(`Submitting Planned Slaughter report: ${input.klientReferanse}`);

    try {
      // Transform GraphQL input to API payload - ALIGNED WITH OFFICIAL SCHEMA
      const payload: PlannedSlaughterPayload = {
        klientReferanse: input.klientReferanse,
        organisasjonsnummer: input.organisasjonsnummer,
        lokalitetsnummer: input.lokalitetsnummer,
        kontaktperson: {
          navn: input.kontaktperson.navn,
          epost: input.kontaktperson.epost,
          telefonnummer: input.kontaktperson.telefonnummer,
        },
        uke: input.uke,
        år: input.aar,
        godkjenningsnummer: input.godkjenningsnummer,
        planlagteLokaliteter: input.planlagteLokaliteter.map(l => ({
          organisasjonsnummer: l.organisasjonsnummer,
          lokalitetsnummer: l.lokalitetsnummer,
          ukeplanPerArt: l.ukeplanPerArt.map(u => ({
            artskode: u.artskode,
            mandagKg: u.mandagKg,
            tirsdagKg: u.tirsdagKg,
            onsdagKg: u.onsdagKg,
            torsdagKg: u.torsdagKg,
            fredagKg: u.fredagKg,
            lørdagKg: u.lordagKg,
            søndagKg: u.sondagKg,
          })),
        })),
      };

      const result = await this.mattilsynetApi.submitPlannedSlaughterReport(tenantId, payload);
      return result;
    } catch (error) {
      this.logger.error(`Failed to submit Planned Slaughter report: ${error}`);
      return {
        success: false,
        klientReferanse: input.klientReferanse,
        feilmelding: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Submit an Executed Slaughter report to Mattilsynet
   * POST /api/slakt/v1/utfort
   */
  @Mutation(() => ReportSubmissionResult, { description: 'Submit Executed Slaughter report to Mattilsynet' })
  async submitExecutedSlaughterReport(
    @Args('input') input: SubmitExecutedSlaughterInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    this.logger.log(`Submitting Executed Slaughter report: ${input.klientReferanse}`);

    try {
      // Transform GraphQL input to API payload - ALIGNED WITH OFFICIAL SCHEMA
      const payload: ExecutedSlaughterPayload = {
        klientReferanse: input.klientReferanse,
        organisasjonsnummer: input.organisasjonsnummer,
        lokalitetsnummer: input.lokalitetsnummer,
        kontaktperson: {
          navn: input.kontaktperson.navn,
          epost: input.kontaktperson.epost,
          telefonnummer: input.kontaktperson.telefonnummer,
        },
        slakteuke: input.slakteuke,
        slakteår: input.slakteaar,
        godkjenningsnummer: input.godkjenningsnummer,
        utførteLokaliteter: input.utforteLokaliteter.map(l => ({
          organisasjonsnummer: l.organisasjonsnummer,
          lokalitetsnummer: l.lokalitetsnummer,
          arter: l.arter.map(a => ({
            art: a.art,
            superiorKg: a.superiorKg,
            ordinærKg: a.ordinaerKg,
            produksjonsfiskKg: a.produksjonsfiskKg,
            utkastKg: a.utkastKg,
          })),
        })),
      };

      const result = await this.mattilsynetApi.submitExecutedSlaughterReport(tenantId, payload);
      return result;
    } catch (error) {
      this.logger.error(`Failed to submit Executed Slaughter report: ${error}`);
      return {
        success: false,
        klientReferanse: input.klientReferanse,
        feilmelding: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
