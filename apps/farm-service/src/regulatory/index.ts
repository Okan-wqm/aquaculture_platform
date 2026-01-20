/**
 * Regulatory Module - Public API
 *
 * Exports for Norwegian regulatory reporting services.
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMAS.
 *
 * Includes:
 * - Tenant-specific regulatory settings (company info, Maskinporten credentials)
 * - Mattilsynet API integration for reports
 */

// Module
export { RegulatoryModule } from './regulatory.module';

// Entity
export { RegulatorySettings } from './entities/regulatory-settings.entity';
export type { SiteLocalityMapping, CompanyAddress } from './entities/regulatory-settings.entity';

// Settings Service
export { RegulatorySettingsService } from './regulatory-settings.service';
export type { UpdateRegulatorySettingsInput } from './regulatory-settings.service';

// Settings DTOs
export {
  CompanyAddressInput,
  CompanyAddressOutput,
  SiteLocalityMappingInput,
  SiteLocalityMappingOutput,
  UpdateRegulatorySettingsInput as UpdateRegulatorySettingsGraphQLInput,
  RegulatorySettingsOutput,
  MaskinportenConnectionTestResult,
  DefaultContactOutput,
  RegulatoryConfigurationStatus,
} from './dto/regulatory-settings.dto';

// Services
export {
  MaskinportenService,
  MATTILSYNET_SCOPES,
  ALL_MATTILSYNET_SCOPES,
  MASKINPORTEN_ENVIRONMENTS,
  type MaskinportenConfig,
  type TokenResponse,
  type CachedToken,
} from './maskinporten.service';

export {
  MattilsynetApiService,
  // Common types
  type KontaktpersonPayload,
  type MattilsynetBasePayload,
  // Enum types
  type VirkestoffTypePayload,
  type IkkeMedikamentellTypePayload,
  type MedikamentellTypePayload,
  type ResistensTypePayload,
  type ResistensAarsakTypePayload,
  type TestresultatPayload,
  type RensefiskOpprinnelsePayload,
  // Sea Lice types
  type LusetellingPayload,
  type VirkestoffPayload,
  type VirkestoffStyrkePayload,
  type VirkestoffMengdePayload,
  type IkkeMedikamentellBehandlingPayload,
  type MedikamentellBehandlingPayload,
  type KombinasjonsbehandlingPayload,
  type ResistensMistankePayload,
  type FølsomhetsundersøkelsePayload,
  type SeaLicePayload,
  // Smolt types
  type ProduksjonsenhetSettefiskPayload,
  type SmoltPayload,
  // Cleaner Fish types
  type RensefiskUtsettPayload,
  type RensefiskUttakPayload,
  type RensefiskArtPayload,
  type ProduksjonsenhetRensefiskPayload,
  type CleanerFishPayload,
  // Slaughter types - ALIGNED WITH OFFICIAL API
  type UkeplanPerArtPayload,           // NEW - Weekly plan per species
  type PlannedSlaughterLocalityPayload,
  type PlannedSlaughterPayload,
  type KvalitetsklasserPerArtPayload,  // NEW - Quality grades per species
  type ExecutedSlaughterLocalityPayload,
  type ExecutedSlaughterPayload,
  // Response type
  type MattilsynetApiResponse,
} from './mattilsynet-api.service';

// Resolver
export { RegulatoryResolver } from './regulatory.resolver';

// GraphQL DTOs - Enums
export {
  // Sea Lice Enums
  IkkeMedikamentellBehandlingType,
  MedikamentellBehandlingType,
  VirkestoffType,
  StyrkeEnhet,
  MengdeEnhet,
  ResistensType,
  ResistensAarsakType,  // NEW - For resistance suspicion causes
  Testresultat,
  // Cleaner Fish Enums
  CleanerFishSpeciesCode,
  CleanerFishOpprinnelse,
} from './dto/regulatory-inputs.dto';

// GraphQL DTOs - Common
export {
  KontaktpersonInput,
  RegulatoryBaseInput,
} from './dto/regulatory-inputs.dto';

// GraphQL DTOs - Sea Lice
export {
  LusetellingInput,
  IkkeMedikamentellBehandlingInput,
  VirkestoffStyrkeInput,
  VirkestoffMengdeInput,
  VirkestoffInput,
  MedikamentellBehandlingInput,
  KombinasjonsbehandlingInput,
  ResistensMistankeInput,
  FolsomhetsundersokelseInput,
  SubmitSeaLiceReportInput,
} from './dto/regulatory-inputs.dto';

// GraphQL DTOs - Smolt
export {
  ProduksjonsenhetSettefiskInput,
  SubmitSmoltReportInput,
} from './dto/regulatory-inputs.dto';

// GraphQL DTOs - Cleaner Fish
export {
  RensefiskUtsettInput,
  RensefiskUttakInput,
  RensefiskArtInput,
  ProduksjonsenhetRensefiskInput,
  SubmitCleanerFishReportInput,
} from './dto/regulatory-inputs.dto';

// GraphQL DTOs - Slaughter
export {
  UkeplanPerArtInput,           // NEW - Weekly plan per species with daily kg
  PlannedSlaughterLocalityInput,
  SubmitPlannedSlaughterInput,
  KvalitetsklasserPerArtInput,  // NEW - Quality grades per species
  ExecutedSlaughterLocalityInput,
  SubmitExecutedSlaughterInput,
} from './dto/regulatory-inputs.dto';

// GraphQL DTOs - Response Types
export {
  ReportValidationError,
  ReportSubmissionResult,
} from './dto/regulatory-inputs.dto';
