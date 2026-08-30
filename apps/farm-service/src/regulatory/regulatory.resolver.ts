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
import { BadRequestException, Logger, UnauthorizedException, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles, Role } from '@aquaculture/backend-common/decorators';
import {
  MattilsynetApiService,
  MattilsynetBasePayload,
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
  MattilsynetSchemaValidatorService,
  MattilsynetSchemaValidationError,
} from './services/mattilsynet-schema-validator.service';
import { MattilsynetRestReportType } from './schemas';
import type { ValidatedPayload } from './schemas';
import {
  SubmitSeaLiceReportInput,
  SubmitCleanerFishReportInput,
  SubmitSmoltReportInput,
  SubmitPlannedSlaughterInput,
  SubmitExecutedSlaughterInput,
  ReportSubmissionResult,
} from './dto/regulatory-inputs.dto';
import {
  SubmitWelfareEventInput,
  SubmitEscapeReportInput,
  SubmitDiseaseOutbreakInput,
} from './dto/regulatory-varsling-inputs.dto';
import { RegulatoryVarslingService } from './services/regulatory-varsling.service';
import { RegulatorySubmissionService } from './services/regulatory-submission.service';
import { SlaughterFacilityService } from './services/slaughter-facility.service';
import { RegulatoryReportType } from './entities/regulatory-report.entity';
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
  configured!: boolean;

  @Field()
  environment!: string;

  @Field(() => [String])
  scopes!: string[];

  @Field({ nullable: true })
  tokenEndpoint?: string;
}

@ObjectType()
class MattilsynetStatus {
  @Field()
  baseUrl!: string;

  @Field()
  environment!: string;

  @Field()
  maskinportenConfigured!: boolean;
}

@ObjectType()
class RegulatoryHealthStatus {
  @Field()
  maskinportenHealthy!: boolean;

  @Field()
  mattilsynetHealthy!: boolean;

  @Field({ nullable: true })
  message?: string;
}

// ============================================================================
// Resolver
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver()
export class RegulatoryResolver {
  private readonly logger = new Logger(RegulatoryResolver.name);

  constructor(
    private readonly mattilsynetApi: MattilsynetApiService,
    private readonly maskinporten: MaskinportenService,
    private readonly settingsService: RegulatorySettingsService,
    private readonly varslingService: RegulatoryVarslingService,
    private readonly schemaValidator: MattilsynetSchemaValidatorService,
    private readonly submissionService: RegulatorySubmissionService,
    private readonly slaughterFacilityService: SlaughterFacilityService,
  ) {}

  /**
   * Validate a payload against the official Mattilsynet schema BEFORE the
   * persist-first flow starts. A schema-invalid payload never creates a
   * PENDING row — the report never existed as an attempt — and the field
   * errors are returned in the regulator's own valideringsfeil shape.
   */
  private validateOfficialSchema<T extends MattilsynetBasePayload>(
    reportType: MattilsynetRestReportType,
    payload: T,
  ): { ok: true; payload: ValidatedPayload<T> } | { ok: false; result: ReportSubmissionResult } {
    try {
      return { ok: true, payload: this.schemaValidator.validate(reportType, payload) };
    } catch (error) {
      if (error instanceof MattilsynetSchemaValidationError) {
        return {
          ok: false,
          result: {
            success: false,
            klientReferanse: payload.klientReferanse,
            feilmelding: 'Payload failed official Mattilsynet schema validation',
            valideringsfeil: error.valideringsfeil,
          },
        };
      }
      throw error;
    }
  }

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
   * Extract the authenticated user id (JWT `sub`) from the GraphQL context.
   * Used to stamp the immediate-report events with `userId` for audit.
   */
  private getUserId(ctx: GraphQLContext): string {
    const userId = ctx?.req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('User context required');
    }
    return userId;
  }

  /**
   * SEC-HIGH-001: the direct REST submit path takes organisasjonsnummer +
   * lokalitetsnummer from the client. Verify each declared (org, lokalitet) pair
   * is a real tenant-owned site (the draft path already derives them server-side),
   * so an operator cannot attribute a legally-binding government filing to an org
   * or lokalitet that is not a configured site of their tenant. Fail closed.
   */
  private async assertTenantOwnsIdentity(
    tenantId: string,
    identities: Array<{ organisasjonsnummer: string; lokalitetsnummer: number }>,
  ): Promise<void> {
    const mappings = await this.settingsService.getEffectiveSiteLocalityMappings(tenantId);
    for (const { organisasjonsnummer, lokalitetsnummer } of identities) {
      const ownedSiteId = Object.entries(mappings).find(
        ([, lokalitet]) => lokalitet === lokalitetsnummer,
      )?.[0];
      if (!ownedSiteId) {
        throw new BadRequestException(
          `lokalitetsnummer ${lokalitetsnummer} is not a configured site for this tenant`,
        );
      }
      const expectedOrg = await this.settingsService.getEffectiveOrganisationNumber(
        tenantId,
        ownedSiteId,
      );
      if (expectedOrg && organisasjonsnummer !== expectedOrg) {
        throw new BadRequestException(
          `organisasjonsnummer does not match the tenant configuration for lokalitet ${lokalitetsnummer}`,
        );
      }
    }
  }

  /**
   * Map entity to GraphQL output
   */
  private async mapSettingsToOutput(tenantId: string): Promise<RegulatorySettingsOutput> {
    const settings = await this.settingsService.getSettings(tenantId);
    const maskedClientId = await this.settingsService.getMaskedClientId(tenantId);
    const effectiveMappings = await this.settingsService.getEffectiveSiteLocalityMappings(tenantId);

    if (!settings) {
      return {
        maskinportenConfigured: false,
        siteLocalityMappings: [],
      };
    }

    // Transform the EFFECTIVE mappings (sites-first SSoT, jsonb fallback)
    // to array format — the frontend identity SSoT consumes this output.
    const mappingsArray: SiteLocalityMappingOutput[] = Object.entries(effectiveMappings).map(
      ([siteId, lokalitetsnummer]) => ({
        siteId,
        lokalitetsnummer,
      }),
    );

    return {
      id: settings.id,
      companyName: settings.companyName,
      organisationNumber: settings.organisationNumber,
      companyAddress: settings.companyAddress,
      maskinportenConfigured: !!(
        settings.maskinportenClientId && settings.maskinportenPrivateKeyEncrypted
      ),
      maskinportenEnvironment: settings.maskinportenEnvironment,
      maskinportenClientIdMasked: maskedClientId || undefined,
      maskinportenKeyId: settings.maskinportenKeyId,
      defaultContactName: settings.defaultContactName,
      defaultContactEmail: settings.defaultContactEmail,
      defaultContactPhone: settings.defaultContactPhone,
      siteLocalityMappings: mappingsArray,
      autoSubmitPolicies: Object.entries(settings.autoSubmitPolicies ?? {}).map(
        ([reportType, enabled]) => ({ reportType, enabled }),
      ),
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
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => RegulatoryConfigurationStatus, {
    description: 'Get regulatory configuration status for the current tenant',
  })
  async regulatoryConfigurationStatus(
    @Context() ctx: GraphQLContext,
  ): Promise<RegulatoryConfigurationStatus> {
    const tenantId = this.getTenantId(ctx);
    const settings = await this.settingsService.getSettings(tenantId);

    const hasCompanyInfo = !!(settings?.companyName && settings?.organisationNumber);
    const hasMaskinportenCredentials = !!(
      settings?.maskinportenClientId && settings?.maskinportenPrivateKeyEncrypted
    );
    const hasDefaultContact = !!(settings?.defaultContactName && settings?.defaultContactEmail);
    const siteMappingsCount = Object.keys(
      await this.settingsService.getEffectiveSiteLocalityMappings(tenantId),
    ).length;
    // The slaughter-facility catalog is the SSoT — a configured default facility
    // is what makes the slakt godkjenningsnummer resolvable (Phase 4 dedup).
    const hasSlaughterApproval =
      !!(await this.slaughterFacilityService.getDefaultFacility(tenantId));

    return {
      hasCompanyInfo,
      hasMaskinportenCredentials,
      hasDefaultContact,
      siteMappingsCount,
      hasSlaughterApproval,
      isFullyConfigured:
        hasCompanyInfo && hasMaskinportenCredentials && hasDefaultContact && siteMappingsCount > 0,
    };
  }

  // ==========================================================================
  // Mutations - Regulatory Settings
  // ==========================================================================

  /**
   * Update regulatory settings for current tenant
   */
  @Roles(Role.TENANT_ADMIN)
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
    });

    return this.mapSettingsToOutput(tenantId);
  }

  /**
   * Test Maskinporten connection with tenant credentials
   */
  @Roles(Role.TENANT_ADMIN)
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
          error:
            'Maskinporten credentials not configured. Please configure client ID and private key first.',
        };
      }

      // Try to get a token
      const token = await this.maskinporten.getAccessToken(tenantId, [MATTILSYNET_SCOPES.SEA_LICE]);

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
    } catch {
      // The provider/JWT/crypto error is an untrusted integration boundary. It
      // may contain a token response body, endpoint URL, issuer, key material,
      // or a library-specific diagnostic. Keep both the GraphQL response and
      // the application log on a stable, non-reflective contract.
      this.logger.error({
        message: 'Maskinporten connection test failed',
        phase: 'connection_test',
      });
      return {
        success: false,
        error: 'Maskinporten connection test failed',
      };
    }
  }

  // ==========================================================================
  // Queries - Service Status (Legacy)
  // ==========================================================================

  /**
   * Get Maskinporten configuration status
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => MaskinportenStatus, { description: 'Get Maskinporten configuration status' })
  async maskinportenStatus(): Promise<MaskinportenStatus> {
    return this.maskinporten.getStatus();
  }

  /**
   * Get Mattilsynet API configuration status
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => MattilsynetStatus, { description: 'Get Mattilsynet API configuration status' })
  async mattilsynetStatus(@Context() ctx: GraphQLContext): Promise<MattilsynetStatus> {
    const tenantId = this.getTenantId(ctx);
    return this.mattilsynetApi.getStatus(tenantId);
  }

  /**
   * Check regulatory services health
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, { description: 'Submit Sea Lice report to Mattilsynet' })
  async submitSeaLiceReport(
    @Args('input') input: SubmitSeaLiceReportInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    const userId = this.getUserId(ctx);
    this.logger.log(`Submitting Sea Lice report: ${input.klientReferanse}`);
    await this.assertTenantOwnsIdentity(tenantId, [
      { organisasjonsnummer: input.organisasjonsnummer, lokalitetsnummer: input.lokalitetsnummer },
    ]);

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
      ikkeMedikamentelleBehandlinger: input.ikkeMedikamentelleBehandlinger?.map((b) => ({
        type: b.type as IkkeMedikamentellTypePayload,
        gjennomførtFørTelling: b.gjennomfortForTelling,
        heleLokaliteten: b.heleLokaliteten,
        antallMerder: b.antallMerder,
        beskrivelse: b.beskrivelse,
      })),
      medikamentelleBehandlinger: input.medikamentelleBehandlinger?.map((b) => ({
        type: b.type as MedikamentellTypePayload,
        gjennomførtFørTelling: b.gjennomfortForTelling,
        heleLokaliteten: b.heleLokaliteten,
        antallMerder: b.antallMerder,
        virkestoff: {
          type: b.virkestoff.type as VirkestoffTypePayload,
          styrke: b.virkestoff.styrke
            ? {
                verdi: b.virkestoff.styrke.verdi,
                enhet: b.virkestoff.styrke.enhet as VirkestoffStyrkePayload['enhet'],
              }
            : undefined,
          mengde: b.virkestoff.mengde
            ? {
                verdi: b.virkestoff.mengde.verdi,
                enhet: b.virkestoff.mengde.enhet as VirkestoffMengdePayload['enhet'],
              }
            : undefined,
          annetVirkestoff: b.virkestoff.annetVirkestoff,
        },
        beskrivelse: b.beskrivelse,
      })),
      // Combination treatments - ALIGNED WITH OFFICIAL KombinasjonsbehandlingDto
      kombinasjonsbehandlinger: input.kombinasjonsbehandlinger?.map((k) => ({
        ikkeMedikamentelleBehandlinger: k.ikkeMedikamentelleBehandlinger?.map((b) => ({
          type: b.type as IkkeMedikamentellTypePayload,
          gjennomførtFørTelling: b.gjennomfortForTelling,
          heleLokaliteten: b.heleLokaliteten,
          antallMerder: b.antallMerder,
          beskrivelse: b.beskrivelse,
        })),
        medikamentelleBehandlinger: k.medikamentelleBehandlinger?.map((b) => ({
          type: b.type as MedikamentellTypePayload,
          gjennomførtFørTelling: b.gjennomfortForTelling,
          heleLokaliteten: b.heleLokaliteten,
          antallMerder: b.antallMerder,
          virkestoff: {
            type: b.virkestoff.type as VirkestoffTypePayload,
            styrke: b.virkestoff.styrke
              ? {
                  verdi: b.virkestoff.styrke.verdi,
                  enhet: b.virkestoff.styrke.enhet as VirkestoffStyrkePayload['enhet'],
                }
              : undefined,
            mengde: b.virkestoff.mengde
              ? {
                  verdi: b.virkestoff.mengde.verdi,
                  enhet: b.virkestoff.mengde.enhet as VirkestoffMengdePayload['enhet'],
                }
              : undefined,
            annetVirkestoff: b.virkestoff.annetVirkestoff,
          },
          beskrivelse: b.beskrivelse,
        })),
      })),
      // Resistance suspicions - ALIGNED WITH OFFICIAL MistankeOmResistensDto
      resistensMistanker: input.resistensMistanker?.map((r) => ({
        resistens: r.resistens as ResistensTypePayload,
        årsak: r.aarsak as ResistensAarsakTypePayload,
        annenResistens: r.annenResistens,
        annenÅrsak: r.annenAarsak,
      })),
      følsomhetsundersøkelser: input.folsomhetsundersokelser?.map((f) => ({
        utførtDato: f.utfortDato,
        laboratorium: f.laboratorium,
        resistens: f.resistens as ResistensTypePayload,
        testresultat: f.testresultat as TestresultatPayload,
      })),
    };

    const validated = this.validateOfficialSchema(RegulatoryReportType.SEA_LICE, payload);
    if (!validated.ok) {
      return validated.result;
    }

    return this.submissionService.submitWithRecord(
      tenantId,
      userId,
      RegulatoryReportType.SEA_LICE,
      input,
      { year: input.rapporteringsaar, week: input.rapporteringsuke },
      validated.payload,
      async () => this.mattilsynetApi.submitSeaLiceReport(tenantId, validated.payload),
    );
  }

  /**
   * Submit a Cleaner Fish report to Mattilsynet
   * POST /api/rensefisk/v1/rensefisk
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, {
    description: 'Submit Cleaner Fish report to Mattilsynet',
  })
  async submitCleanerFishReport(
    @Args('input') input: SubmitCleanerFishReportInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    const userId = this.getUserId(ctx);
    this.logger.log(`Submitting Cleaner Fish report: ${input.klientReferanse}`);
    await this.assertTenantOwnsIdentity(tenantId, [
      { organisasjonsnummer: input.organisasjonsnummer, lokalitetsnummer: input.lokalitetsnummer },
    ]);

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
      produksjonsenheter: input.produksjonsenheter.map((p) => ({
        merdId: p.merdId,
        arter: p.arter.map((a) => ({
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
            antallAvlivetForeståendeHåndteringAvLaksen:
              a.uttak.antallAvlivetForestaendeHaandteringAvLaksen,
            antallAvlivetForeståendeUgunstigLevemiljø:
              a.uttak.antallAvlivetForestaendeUgunstigLevemiljo,
            antallAvlivetSkalIkkeBrukes: a.uttak.antallAvlivetSkalIkkeBrukes,
            antallSelvdød: a.uttak.antallSelvdod,
            antallFlyttetUt: a.uttak.antallFlyttetUt,
            antallKanIkkeGjøresRedeFor: a.uttak.antallKanIkkeGjoresRedeFor,
          },
        })),
      })),
    };

    const validated = this.validateOfficialSchema(RegulatoryReportType.CLEANER_FISH, payload);
    if (!validated.ok) {
      return validated.result;
    }

    return this.submissionService.submitWithRecord(
      tenantId,
      userId,
      RegulatoryReportType.CLEANER_FISH,
      input,
      { year: input.rapporteringsaar, month: input.rapporteringsmaaned },
      validated.payload,
      async () => this.mattilsynetApi.submitCleanerFishReport(tenantId, validated.payload),
    );
  }

  /**
   * Submit a Smolt report to Mattilsynet
   * POST /api/settefisk/v1/settefisk
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, { description: 'Submit Smolt report to Mattilsynet' })
  async submitSmoltReport(
    @Args('input') input: SubmitSmoltReportInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    const userId = this.getUserId(ctx);
    this.logger.log(`Submitting Smolt report: ${input.klientReferanse}`);
    await this.assertTenantOwnsIdentity(tenantId, [
      { organisasjonsnummer: input.organisasjonsnummer, lokalitetsnummer: input.lokalitetsnummer },
    ]);

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
      produksjonsenheter: input.produksjonsenheter.map((p) => ({
        karId: p.karId,
        artskode: p.artskode,
        snittvektGram: p.snittvektGram,
        beholdningVedMånedsslutt: p.beholdningVedMaanedsslutt,
        antallAvlivet: p.antallAvlivet,
        antallSelvdød: p.antallSelvdod,
        antallFlyttetEksternt: p.antallFlyttetEksternt,
      })),
    };

    const validated = this.validateOfficialSchema(RegulatoryReportType.SMOLT, payload);
    if (!validated.ok) {
      return validated.result;
    }

    return this.submissionService.submitWithRecord(
      tenantId,
      userId,
      RegulatoryReportType.SMOLT,
      input,
      { year: input.rapporteringsaar, month: input.rapporteringsmaaned },
      validated.payload,
      async () => this.mattilsynetApi.submitSmoltReport(tenantId, validated.payload),
    );
  }

  /**
   * Submit a Planned Slaughter report to Mattilsynet
   * POST /api/slakt/v1/planlagt
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, {
    description: 'Submit Planned Slaughter report to Mattilsynet',
  })
  async submitPlannedSlaughterReport(
    @Args('input') input: SubmitPlannedSlaughterInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    const userId = this.getUserId(ctx);
    this.logger.log(`Submitting Planned Slaughter report: ${input.klientReferanse}`);
    await this.assertTenantOwnsIdentity(tenantId, [
      { organisasjonsnummer: input.organisasjonsnummer, lokalitetsnummer: input.lokalitetsnummer },
      ...input.planlagteLokaliteter.map((l) => ({
        organisasjonsnummer: l.organisasjonsnummer,
        lokalitetsnummer: l.lokalitetsnummer,
      })),
    ]);

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
      planlagteLokaliteter: input.planlagteLokaliteter.map((l) => ({
        organisasjonsnummer: l.organisasjonsnummer,
        lokalitetsnummer: l.lokalitetsnummer,
        ukeplanPerArt: l.ukeplanPerArt.map((u) => ({
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

    const validated = this.validateOfficialSchema(RegulatoryReportType.SLAUGHTER_PLANNED, payload);
    if (!validated.ok) {
      return validated.result;
    }

    return this.submissionService.submitWithRecord(
      tenantId,
      userId,
      RegulatoryReportType.SLAUGHTER_PLANNED,
      input,
      { year: input.aar, week: input.uke },
      validated.payload,
      async () => this.mattilsynetApi.submitPlannedSlaughterReport(tenantId, validated.payload),
    );
  }

  /**
   * Submit an Executed Slaughter report to Mattilsynet
   * POST /api/slakt/v1/utfort
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, {
    description: 'Submit Executed Slaughter report to Mattilsynet',
  })
  async submitExecutedSlaughterReport(
    @Args('input') input: SubmitExecutedSlaughterInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    const userId = this.getUserId(ctx);
    this.logger.log(`Submitting Executed Slaughter report: ${input.klientReferanse}`);
    await this.assertTenantOwnsIdentity(tenantId, [
      { organisasjonsnummer: input.organisasjonsnummer, lokalitetsnummer: input.lokalitetsnummer },
      ...input.utforteLokaliteter.map((l) => ({
        organisasjonsnummer: l.organisasjonsnummer,
        lokalitetsnummer: l.lokalitetsnummer,
      })),
    ]);

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
      utførteLokaliteter: input.utforteLokaliteter.map((l) => ({
        organisasjonsnummer: l.organisasjonsnummer,
        lokalitetsnummer: l.lokalitetsnummer,
        arter: l.arter.map((a) => ({
          art: a.art,
          superiorKg: a.superiorKg,
          ordinærKg: a.ordinaerKg,
          produksjonsfiskKg: a.produksjonsfiskKg,
          utkastKg: a.utkastKg,
        })),
      })),
    };

    const validated = this.validateOfficialSchema(RegulatoryReportType.SLAUGHTER_EXECUTED, payload);
    if (!validated.ok) {
      return validated.result;
    }

    return this.submissionService.submitWithRecord(
      tenantId,
      userId,
      RegulatoryReportType.SLAUGHTER_EXECUTED,
      input,
      { year: input.slakteaar, week: input.slakteuke },
      validated.payload,
      async () => this.mattilsynetApi.submitExecutedSlaughterReport(tenantId, validated.payload),
    );
  }

  /**
   * Replay a persisted FAILED REST submission under the SAME klientReferanse
   * (Mattilsynet idempotency). The stored payload is re-validated through the
   * brand gate before it can reach the regulator, so a payload that has since
   * become schema-invalid becomes a PERMANENT failure instead of a re-send.
   * This is the manual counterpart to the 30-minute retry sweep.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, {
    description: 'Replay a previously failed Mattilsynet REST report submission',
  })
  async resubmitRegulatoryReport(
    @Args('reportId') reportId: string,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    this.logger.log(`Resubmitting regulatory report: ${reportId}`);
    return this.submissionService.resubmit(tenantId, reportId);
  }

  // ==========================================================================
  // Mutations - Immediate "varsling" Reports (Welfare / Escape / Disease)
  // ==========================================================================
  //
  // These three are legally-immediate notifications routed to
  // varsling.akva@mattilsynet.no (escapes also to Fiskeridirektoratet).
  // They are NOT part of the Mattilsynet REST `innrapportering-api`, so they
  // go through RegulatoryVarslingService → transactional outbox →
  // notification-service email dispatch, not MattilsynetApiService.

  /**
   * Submit a Welfare Event report (varsling) to Mattilsynet.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, {
    description: 'Submit immediate Welfare Event report (varsling) to Mattilsynet',
  })
  async submitWelfareEvent(
    @Args('input') input: SubmitWelfareEventInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    const userId = this.getUserId(ctx);
    this.logger.log(`Submitting Welfare Event report: ${input.klientReferanse}`);
    return this.varslingService.submitWelfareEvent(tenantId, userId, input);
  }

  /**
   * Submit a fish Escape report (varsling) to Mattilsynet + Fiskeridirektoratet.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, {
    description: 'Submit immediate Escape report (varsling) to Mattilsynet',
  })
  async submitEscapeReport(
    @Args('input') input: SubmitEscapeReportInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    const userId = this.getUserId(ctx);
    this.logger.log(`Submitting Escape report: ${input.klientReferanse}`);
    return this.varslingService.submitEscapeReport(tenantId, userId, input);
  }

  /**
   * Submit a notifiable Disease Outbreak report (varsling) to Mattilsynet.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, {
    description: 'Submit immediate Disease Outbreak report (varsling) to Mattilsynet',
  })
  async submitDiseaseOutbreak(
    @Args('input') input: SubmitDiseaseOutbreakInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    const tenantId = this.getTenantId(ctx);
    const userId = this.getUserId(ctx);
    this.logger.log(`Submitting Disease Outbreak report: ${input.klientReferanse}`);
    return this.varslingService.submitDiseaseOutbreak(tenantId, userId, input);
  }
}
