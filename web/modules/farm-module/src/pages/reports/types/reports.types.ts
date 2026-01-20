/**
 * Norwegian Regulatory Reports - Type Definitions
 *
 * 8 rapor tipi için TypeScript interface'leri:
 * 1. Sea Lice (Lakselus) - Haftalık
 * 2. Biomass - Aylık
 * 3. Smolt (Settefisk) - Aylık
 * 4. Cleaner Fish (Rensefisk) - Aylık
 * 5. Slaughter (Slakt) - Event-based
 * 6. Welfare Events - ACİL
 * 7. Disease Outbreak - ACİL
 * 8. Escape Report - ACİL
 */

// ============================================================================
// Common Types
// ============================================================================

export type ReportStatus = 'draft' | 'pending' | 'submitted' | 'approved' | 'rejected' | 'overdue';

export type ReportType =
  | 'sea-lice'
  | 'biomass'
  | 'smolt'
  | 'cleaner-fish'
  | 'slaughter'                // Legacy/combined type
  | 'slaughter-planned'        // Planlagt Slakt - Weekly to Mattilsynet
  | 'slaughter-executed'       // Utført Slakt - Weekly to Mattilsynet
  | 'welfare'
  | 'disease'
  | 'escape';

export type ReportPriority = 'P1' | 'P2' | 'P3';

/**
 * Contact person - Required for all Mattilsynet API reports
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 */
export interface Kontaktperson {
  navn: string;           // Name
  epost: string;          // Email
  telefonnummer: string;  // Phone number
}

/**
 * Base interface for all reports
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 *
 * IMPORTANT: lokalitetsnummer is NUMBER not string!
 */
export interface ReportBase {
  id: string;
  siteId: string;
  siteName?: string;
  status: ReportStatus;
  createdAt: Date;
  updatedAt: Date;
  submittedAt?: Date;
  submittedBy?: string;
  correctionOf?: string; // Previous report ID if this is a correction

  // Mattilsynet API required fields (regulatory metadata)
  klientReferanse?: string;       // Client reference code (unique per report - UUID)
  organisasjonsnummer?: string;   // Norwegian organization number (9 digits)
  lokalitetsnummer?: number;      // Site/Locality registration number - MUST BE NUMBER!
  kontaktperson?: Kontaktperson;  // Contact person - MUST BE OBJECT!
}

export interface ReportDeadline {
  deadline: Date;
  daysRemaining: number;
  isOverdue: boolean;
  isUrgent: boolean; // <= 3 days
}

// ============================================================================
// 1. Sea Lice Report (Lakselus) - Weekly
// ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
// Endpoint: POST /api/lakselus/v1/lakselus
// ============================================================================

// Enums aligned with Mattilsynet API
export type IkkeMedikamentellBehandlingType =
  | 'TERMISK_BEHANDLING'    // Thermal treatment
  | 'MEKANISK_BEHANDLING'   // Mechanical treatment
  | 'FERSKVANN'             // Freshwater
  | 'SPYLING'               // Flushing
  | 'LASER'                 // Laser
  | 'ANNET';                // Other

export type MedikamentellBehandlingType =
  | 'BADEBEHANDLING'        // Bath treatment
  | 'FORBEHANDLING'         // Feed treatment
  | 'INJEKSJON';            // Injection

export type VirkestoffType =
  | 'AZAMETIFOS'
  | 'CYPERMETHRIN'
  | 'DELTAMETHRIN'
  | 'HYDROGENPEROKSID'
  | 'IMIDAKLOPRID'
  | 'EMAMEKTIN_BENZOAT'
  | 'ANNET';

export type StyrkeEnhet = 'MILLIGRAM_PER_GRAM' | 'MILLIGRAM_PER_LITER' | 'PROSENT';
export type MengdeEnhet = 'GRAM' | 'KILOGRAM' | 'LITER' | 'MILLILITER';
export type Testresultat = 'FOLSOM' | 'NEDSATT_FOLSOMHET' | 'RESISTENT';

// Legacy types for backwards compatibility
export type SeaLiceStage = 'adult_female' | 'mobile' | 'attached';
export type CleanerFishSpecies = 'lumpfish' | 'ballan_wrasse' | 'corkwing_wrasse' | 'goldsinny_wrasse';
export type SensitivityResult = 'sensitive' | 'reduced' | 'resistant';
export type TreatmentType = 'medicated' | 'non_medicated';

/**
 * Lice counting data - Single object (NOT array!)
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 */
export interface Lusetelling {
  voksneHunnlus: number;    // Adult female lice per fish
  bevegeligeLus: number;    // Mobile lice per fish
  fastsittendeLus: number;  // Attached lice per fish
}

// Legacy interface - kept for UI display purposes
export interface SeaLiceCounts {
  adultFemale: number;
  mobile: number;
  attached: number;
  averagePerFish: number;
}

export interface SeaLiceCageCount {
  cageId: string;
  cageName: string;
  batchId?: string;
  batchNumber?: string;
  fishCount: number;
  sampleSize: number;
  counts: SeaLiceCounts;
}

/**
 * Virkestoff (Active ingredient) - ALIGNED WITH API
 */
export interface Virkestoff {
  type: VirkestoffType;
  styrke?: {
    verdi: number;
    enhet: StyrkeEnhet;
  };
  mengde?: {
    verdi: number;
    enhet: MengdeEnhet;
  };
  annetVirkestoff?: string; // Required when type is 'ANNET'
}

/**
 * Non-medicated treatment - ALIGNED WITH API
 */
export interface IkkeMedikamentellBehandling {
  type: IkkeMedikamentellBehandlingType;
  gjennomfortForTelling: boolean;   // Performed before counting
  heleLokaliteten: boolean;          // Whole site treated
  antallMerder?: number;             // Number of cages (if not whole site)
  beskrivelse?: string;              // Description (required for 'ANNET')
}

/**
 * Medicated treatment - ALIGNED WITH API
 */
export interface MedikamentellBehandling {
  type: MedikamentellBehandlingType;
  gjennomfortForTelling: boolean;
  heleLokaliteten: boolean;
  antallMerder?: number;
  virkestoff: Virkestoff;
}

/**
 * Combination treatment - ALIGNED WITH API
 */
export interface Kombinasjonsbehandling {
  ikkeMedikamentellType: string;
  medikamentellType: string;
  gjennomfortForTelling: boolean;
  heleLokaliteten: boolean;
  antallMerder?: number;
  virkestoff: Virkestoff;
}

/**
 * Resistance suspicion - ALIGNED WITH API
 */
export interface ResistensMistanke {
  type: VirkestoffType;
  beskrivelse?: string;
}

/**
 * Sensitivity test - ALIGNED WITH API
 */
export interface Folsomhetsundersokelse {
  utfortDato: string;       // ISO date string
  laboratorium: string;     // Lab name
  resistens: VirkestoffType;
  testresultat: Testresultat;
}

// Legacy interface kept for backwards compatibility
export interface SensitivityTest {
  id: string;
  testDate: Date;
  activeIngredient: string;
  result: SensitivityResult;
  resistanceSuspected: boolean;
  labName?: string;
  notes?: string;
}

// Legacy interface kept for backwards compatibility
export interface SeaLiceTreatment {
  id: string;
  type: TreatmentType;
  date: Date;
  activeIngredient?: string;
  amount?: number;
  unit?: string;
  targetCages?: string[];
  notes?: string;
}

export interface CleanerFishEntry {
  id: string;
  species: CleanerFishSpecies;
  norwegianName: string;
  count: number;
  deploymentDate: Date;
  targetCageId?: string;
  source?: 'wild_caught' | 'farmed';
}

/**
 * Sea Lice Report - ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 *
 * API Endpoint: POST /api/lakselus/v1/lakselus
 * Scope: mattilsynet:akvakultur.innrapportering.lakselus
 */
export interface SeaLiceReport extends ReportBase {
  reportType: 'sea-lice';

  // Report period - ALIGNED WITH API
  rapporteringsaar: number;  // rapporteringsår in API
  rapporteringsuke: number;

  // Legacy fields for UI display
  weekNumber: number;
  year: number;
  reportDate: Date;
  deadline: Date;

  // Water temperature - ALIGNED WITH API
  sjotemperatur: number;     // sjøtemperatur in API - Water temp in Celsius
  waterTemperature3m: number; // Legacy field

  // Lice counting - SINGLE OBJECT (NOT array!) - ALIGNED WITH API
  lusetelling: Lusetelling;

  // Legacy fields for UI display
  siteCounts: SeaLiceCounts;
  cageCounts: SeaLiceCageCount[];

  // Treatments - Split into types as per API
  ikkeMedikamentelleBehandlinger?: IkkeMedikamentellBehandling[];
  medikamentelleBehandlinger?: MedikamentellBehandling[];
  kombinasjonsbehandlinger?: Kombinasjonsbehandling[];

  // Legacy field
  treatments: SeaLiceTreatment[];

  // Resistance and sensitivity - ALIGNED WITH API
  resistensMistanker?: ResistensMistanke[];
  folsomhetsundersokelser?: Folsomhetsundersokelse[];

  // Legacy field
  sensitivityTests: SensitivityTest[];

  // Cleaner fish (separate report in API, but included for UI)
  cleanerFish: CleanerFishEntry[];

  thresholdExceeded: boolean;
  notes?: string;
}

// ============================================================================
// 2. Biomass Report - Monthly
// ============================================================================

export interface BiomassSpeciesBreakdown {
  speciesId: string;
  speciesName: string;
  biomassKg: number;
  fishCount: number;
  avgWeightG: number;
}

export interface StockingRecord {
  id: string;
  date: Date;
  speciesId: string;
  speciesName: string;
  yearClass: number;
  quantity: number;
  avgWeightG: number;
  totalBiomassKg: number;
  sourceSupplier: string;
  batchNumber?: string;
}

export interface MortalityBreakdown {
  cause: string;
  count: number;
  biomassKg?: number;
}

export interface MortalityDetail {
  id: string;
  date: Date;
  count: number;
  cause: string;
  biomassKg?: number;
  notes?: string;
}

export interface SlaughterRecord {
  id: string;
  date: Date;
  batchId: string;
  batchNumber: string;
  quantity: number;
  biomassKg: number;
  avgWeightKg: number;
  destination: string;
  qualityGrade?: string;
}

export interface TransferRecord {
  id: string;
  date: Date;
  fromSite?: string;
  toSite?: string;
  quantity: number;
  biomassKg: number;
  batchNumber?: string;
  reason?: string;
}

export interface FeedConsumptionBreakdown {
  feedId: string;
  feedName: string;
  brandName?: string;
  quantityKg: number;
  cost?: number;
}

export interface NetImpregnation {
  cageId: string;
  cageName: string;
  impregnationType: string;
  activeIngredient: string;
  lastImpregnationDate: Date;
}

export interface BiomassReport extends ReportBase {
  reportType: 'biomass';
  month: number;
  year: number;
  reportDate: Date;
  deadline: Date;
  currentBiomass: {
    totalKg: number;
    bySpecies: BiomassSpeciesBreakdown[];
  };
  stockings: StockingRecord[];
  mortality: {
    totalCount: number;
    totalBiomassKg: number;
    byCause: MortalityBreakdown[];
    details: MortalityDetail[];
  };
  slaughter: {
    totalQuantity: number;
    totalBiomassKg: number;
    records: SlaughterRecord[];
  };
  transfers: {
    incoming: TransferRecord[];
    outgoing: TransferRecord[];
  };
  feedConsumption: {
    totalKg: number;
    totalCost?: number;
    byFeedType: FeedConsumptionBreakdown[];
  };
  netImpregnation?: NetImpregnation[];
  notes?: string;
}

// ============================================================================
// 3. Smolt Report (Settefisk) - Monthly
// ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
// Endpoint: POST /api/settefisk/v1/settefisk
// ============================================================================

export type FacilityType = 'freshwater' | 'land_based';

/**
 * Production unit for Smolt report - ALIGNED WITH API
 */
export interface ProduksjonsenhetSettefisk {
  karId: string;                    // Tank/unit identifier
  artskode: string;                 // Species code (e.g., 'SAL' for salmon)
  snittvektGram: number;            // Average weight in grams
  beholdningVedMaanedsslutt: number; // Stock count at end of month
  antallAvlivet: number;            // Number euthanized
  antallSelvdod: number;            // Number died naturally
  antallFlyttetEksternt: number;    // Number transferred externally
}

// Legacy interfaces kept for backwards compatibility
export interface SmoltUnitCount {
  unitId: string;
  unitName: string;
  unitType: 'tank' | 'raceway' | 'pond';
  quantity: number;
  avgWeightG: number;
  stage?: string;
}

export interface SmoltStageWeight {
  stage: string;
  avgWeightG: number;
  quantity: number;
}

export interface SmoltMortalityUnit {
  unitId: string;
  unitName: string;
  rate: number;
  count: number;
}

/**
 * Smolt Report - ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 *
 * API Endpoint: POST /api/settefisk/v1/settefisk
 * Scope: mattilsynet:akvakultur.innrapportering.settefisk
 */
export interface SmoltReport extends ReportBase {
  reportType: 'smolt';

  // Report period - ALIGNED WITH API
  rapporteringsmaaned: number;  // rapporteringsmåned in API
  rapporteringsaar: number;     // rapporteringsår in API

  // Legacy fields for UI
  month: number;
  year: number;

  facilityType: FacilityType;
  deadline: Date;

  // Production units - ALIGNED WITH API
  produksjonsenheter: ProduksjonsenhetSettefisk[];

  // Legacy fields for UI display
  fishCounts: {
    byUnit: SmoltUnitCount[];
    total: number;
  };
  averageWeights: {
    overall: number;
    byStage: SmoltStageWeight[];
  };
  mortalityRates: {
    overall: number;
    byUnit: SmoltMortalityUnit[];
  };
  transfers?: {
    outgoing: TransferRecord[];
  };
  notes?: string;
}

// ============================================================================
// 4. Cleaner Fish Report (Rensefisk) - Monthly
// ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
// Endpoint: POST /api/rensefisk/v1/rensefisk
// ============================================================================

// Species codes as per Mattilsynet API
export type CleanerFishArtskode = 'USB' | 'BER' | 'GRO' | 'BNB';
// USB = Lumpfish (Rognkjeks)
// BER = Ballan Wrasse (Berggylt)
// GRO = Corkwing Wrasse (Grønngylt)
// BNB = Goldsinny Wrasse (Bergnebb)

export type CleanerFishOpprinnelse = 'VILLFANGET' | 'OPPDRETT';

/**
 * Deployment data - ALIGNED WITH API
 */
export interface RensefiskUtsett {
  antallFlyttetInn: number;  // Transferred in
  antallNy: number;          // New deployment
}

/**
 * Removal data - ALIGNED WITH API (10+ specific cause fields!)
 */
export interface RensefiskUttak {
  antallAvlivetSykdom: number;                        // Euthanized due to disease
  antallAvlivetSkader: number;                        // Euthanized due to injuries
  antallAvlivetAvmagret: number;                      // Euthanized due to emaciation
  antallAvlivetForestaendeHaandteringAvLaksen: number; // Euthanized before salmon handling
  antallAvlivetForestaendeUgunstigLevemiljo: number;   // Euthanized before unfavorable environment
  antallAvlivetSkalIkkeBrukes: number;                // Euthanized - not to be used
  antallSelvdod: number;                              // Died naturally
  antallFlyttetUt: number;                            // Transferred out
  antallKanIkkeGjoresRedeFor: number;                 // Cannot be accounted for
}

/**
 * Species data per cage - ALIGNED WITH API
 */
export interface RensefiskArt {
  artskode: CleanerFishArtskode;
  opprinnelse: CleanerFishOpprinnelse;
  beholdningVedForrigeMaanedsslutt: number;  // Stock at previous month end
  utsett: RensefiskUtsett;
  uttak: RensefiskUttak;
}

/**
 * Production unit (cage) with species data - ALIGNED WITH API
 */
export interface ProduksjonsenhetRensefisk {
  merdId: string;
  arter: RensefiskArt[];
}

// Legacy interfaces kept for backwards compatibility
export interface CleanerFishSpeciesCount {
  species: CleanerFishSpecies;
  norwegianName: string;
  count: number;
  source: 'wild_caught' | 'farmed';
  sourceLocation?: string;
}

export interface CleanerFishMortality {
  species: CleanerFishSpecies;
  count: number;
  rate: number;
}

export interface CleanerFishDeployment {
  id: string;
  date: Date;
  species: CleanerFishSpecies;
  quantity: number;
  targetCageId: string;
  targetCageName?: string;
  salmonBatchId?: string;
}

/**
 * Cleaner Fish Report - ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 *
 * API Endpoint: POST /api/rensefisk/v1/rensefisk
 * Scope: mattilsynet:akvakultur.innrapportering.rensefisk
 */
export interface CleanerFishReport extends ReportBase {
  reportType: 'cleaner-fish';

  // Report period - ALIGNED WITH API
  rapporteringsmaaned: number;  // rapporteringsmåned in API
  rapporteringsaar: number;     // rapporteringsår in API

  // Legacy fields for UI
  month: number;
  year: number;
  deadline: Date;

  // Co-operation organizations - ALIGNED WITH API
  samdriftOrganisasjonsnumre?: string[];

  // Feed data - ALIGNED WITH API
  produksjonssyklusStart?: string;  // ISO date string
  torrforKg?: number;               // Dry feed consumption (kg)
  vatforKg?: number;                // Wet feed consumption (kg)

  // Production units with species - ALIGNED WITH API
  produksjonsenheter: ProduksjonsenhetRensefisk[];

  // Legacy fields for UI display
  fishBySpecies: CleanerFishSpeciesCount[];
  totalCount: number;
  mortality: {
    bySpecies: CleanerFishMortality[];
    totalCount: number;
    overallRate: number;
  };
  deployments: CleanerFishDeployment[];
  notes?: string;
}

// ============================================================================
// 5. Slaughter Report (Slakt) - Event-based
// ============================================================================

export type SlaughterReportType = 'planned' | 'completed';
export type SlaughterPlanStatus = 'planned' | 'approved' | 'in_progress' | 'completed' | 'cancelled';

export interface PlannedSlaughter {
  planId: string;
  batchId: string;
  batchNumber: string;
  speciesName?: string;
  plannedDate: Date;
  estimatedQuantity: number;
  estimatedBiomassKg: number;
  estimatedAvgWeightKg: number;
  slaughterHouse: string;
  status: SlaughterPlanStatus;
  approvedAt?: Date;
  notes?: string;
}

export interface CompletedSlaughter {
  recordId: string;
  batchId: string;
  batchNumber: string;
  speciesName?: string;
  harvestDate: Date;
  actualQuantity: number;
  actualBiomassKg: number;
  avgWeightKg: number;
  slaughterHouse: string;
  qualityGrade?: string;
  lotNumber?: string;
  notes?: string;
}

export interface SlaughterReport extends ReportBase {
  reportType: 'slaughter';
  reportPeriodType: SlaughterReportType;
  plannedSlaughters: PlannedSlaughter[];
  completedSlaughters: CompletedSlaughter[];
  summary: {
    totalPlanned: number;
    totalCompleted: number;
    plannedBiomassKg: number;
    completedBiomassKg: number;
    variance?: number;
  };
  notes?: string;
}

// ============================================================================
// 5b. Planned Slaughter Report (Planlagt Slakt) - Weekly to Mattilsynet API
// ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
// Endpoint: POST /api/slakt/v1/planlagt
// ============================================================================

/**
 * Planned slaughter locality data - ALIGNED WITH API
 * IMPORTANT: lokalitetsnummer is NUMBER not string!
 */
export interface PlannedSlaughterLocalitet {
  lokalitetsnummer: number;     // NUMBER - Site registration number
  lokalitetsnavn?: string;      // UI only
  art: string;                  // Species name
  artskode?: string;            // Species code
  antall: number;               // Quantity
  mengdeKg: number;             // Biomass in kg
  gjennomsnittsvektKg?: number; // Average weight (optional for planned)
  slakteDato: string;           // ISO date string - Planned slaughter date
  batchId?: string;             // UI only
  batchNumber?: string;         // UI only
}

/**
 * Planned Slaughter Report - ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 *
 * API Endpoint: POST /api/slakt/v1/planlagt
 * Scope: mattilsynet:akvakultur.innrapportering.slakt
 */
export interface PlannedSlaughterReport extends ReportBase {
  reportType: 'slaughter-planned';

  // Report period - ALIGNED WITH API
  uke: number;                  // Week number
  aar: number;                  // Year

  // Legacy fields for UI
  week: number;
  year: number;
  deadline: Date;

  godkjenningsnummer: string;   // Slaughter facility approval number (REQUIRED)
  godkjenningsnavn?: string;    // UI only - Slaughter facility name
  planlagteLokaliteter: PlannedSlaughterLocalitet[];
  notes?: string;
}

// ============================================================================
// 5c. Executed Slaughter Report (Utført Slakt) - Weekly to Mattilsynet API
// ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
// Endpoint: POST /api/slakt/v1/utfort
// ============================================================================

/**
 * Executed slaughter locality data - ALIGNED WITH API
 * IMPORTANT: lokalitetsnummer is NUMBER not string!
 */
export interface ExecutedSlaughterLocalitet {
  lokalitetsnummer: number;     // NUMBER - Site registration number
  lokalitetsnavn?: string;      // UI only
  art: string;                  // Species name
  artskode?: string;            // Species code
  antall: number;               // Quantity
  mengdeKg: number;             // Biomass in kg
  gjennomsnittsvektKg: number;  // Average weight (REQUIRED for executed)
  slakteDato: string;           // ISO date string - Actual slaughter date
  kvalitetsgrad?: string;       // Quality grade
  batchId?: string;             // UI only
  batchNumber?: string;         // UI only
  lotNumber?: string;           // UI only - Lot number for traceability
}

/**
 * Executed Slaughter Report - ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMA
 *
 * API Endpoint: POST /api/slakt/v1/utfort
 * Scope: mattilsynet:akvakultur.innrapportering.slakt
 */
export interface ExecutedSlaughterReport extends ReportBase {
  reportType: 'slaughter-executed';

  // Report period - ALIGNED WITH API
  slakteuke: number;            // Slaughter week number
  slakteaar: number;            // slakteår in API - Slaughter year

  // Legacy field for UI
  deadline: Date;

  godkjenningsnummer: string;   // Slaughter facility approval number (REQUIRED)
  godkjenningsnavn?: string;    // UI only - Slaughter facility name
  utforteLokaliteter: ExecutedSlaughterLocalitet[];  // utførteLokaliteter in API
  notes?: string;
}

// ============================================================================
// 6. Welfare Event Report - IMMEDIATE
// ============================================================================

export type WelfareEventType = 'mortality_threshold' | 'equipment_failure' | 'welfare_impact';
export type WelfareEventSeverity = 'high' | 'critical';
export type WelfareEventStatus = 'detected' | 'reported' | 'acknowledged' | 'under_investigation' | 'resolved';
export type MortalityPeriod = '1_day' | '3_day' | '7_day';

export interface AffectedBatch {
  batchId: string;
  batchNumber: string;
  speciesName?: string;
  mortalityCount: number;
  mortalityRate?: number;
}

export interface MortalityThresholdData {
  period: MortalityPeriod;
  threshold: number;
  actualRate: number;
  affectedBatches: AffectedBatch[];
}

export interface EquipmentFailureData {
  equipmentId: string;
  equipmentName: string;
  equipmentType: string;
  failureType: string;
  injuredFishCount?: number;
  mortalityCount?: number;
  description: string;
}

export interface WelfareImpactData {
  description: string;
  affectedFishEstimate: number;
  affectedPercentage?: number;
  immediateActions: string[];
  ongoingRisks?: string[];
}

export interface ReportAcknowledgement {
  acknowledgedAt: Date;
  acknowledgedBy: string;
  referenceNumber: string;
  notes?: string;
}

export interface WelfareEventReport extends ReportBase {
  reportType: 'welfare';
  eventType: WelfareEventType;
  severity: WelfareEventSeverity;
  detectedAt: Date;
  reportedAt?: Date;
  contactEmail: string; // varsling.akva@mattilsynet.no
  reportedBy?: string;
  mortalityData?: MortalityThresholdData;
  equipmentData?: EquipmentFailureData;
  welfareData?: WelfareImpactData;
  immediateActions: string[];
  acknowledgement?: ReportAcknowledgement;
  resolutionNotes?: string;
  resolvedAt?: Date;
}

// ============================================================================
// 7. Disease Outbreak Report - IMMEDIATE
// ============================================================================

export type DiseaseCategory = 'A' | 'C' | 'F';
export type DiseaseConfirmation = 'suspected' | 'lab_confirmed';
export type DiseaseStatus = 'detected' | 'reported' | 'under_investigation' | 'confirmed' | 'resolved';

export interface DiseaseInfo {
  category: DiseaseCategory;
  name: string;
  norwegianName?: string;
  code?: string;
  suspectedOrConfirmed: DiseaseConfirmation;
}

export interface AffectedPopulation {
  estimatedCount: number;
  percentage: number;
  batches: AffectedBatch[];
  tanks: string[];
}

export interface FacilityInfo {
  siteId: string;
  siteName: string;
  siteCode: string;
  gpsCoordinates?: {
    lat: number;
    lng: number;
  };
}

export interface LabResult {
  id: string;
  labName: string;
  sampleDate: Date;
  resultDate?: Date;
  testType: string;
  result: string;
  interpretation?: string;
}

export interface DiseaseOutbreakReport extends ReportBase {
  reportType: 'disease';
  diseaseStatus: DiseaseStatus;
  detectedAt: Date;
  reportedAt?: Date;
  contactEmail: string; // varsling.akva@mattilsynet.no
  reportedBy?: string;
  disease: DiseaseInfo;
  affectedPopulation: AffectedPopulation;
  facility: FacilityInfo;
  clinicalSigns: string[];
  labResults: LabResult[];
  immediateActions: string[];
  quarantineMeasures?: string[];
  veterinarianNotified: boolean;
  veterinarianName?: string;
  veterinarianContact?: string;
  acknowledgement?: ReportAcknowledgement;
  resolutionNotes?: string;
  resolvedAt?: Date;
}

// ============================================================================
// 8. Escape Report (Rømmingsmeldinger) - IMMEDIATE
// ============================================================================

export type EscapeCause = 'equipment_failure' | 'storm_damage' | 'predator_attack' | 'human_error' | 'unknown';
export type EscapeStatus = 'detected' | 'reported' | 'investigation' | 'closed';

export interface EscapeDetails {
  estimatedCount: number;
  species: string;
  speciesId?: string;
  avgWeightG: number;
  totalBiomassKg: number;
  cause: EscapeCause;
  causeDescription: string;
}

export interface AffectedUnit {
  unitId: string;
  unitName: string;
  unitType: 'cage' | 'tank' | 'pond';
  batchId: string;
  batchNumber: string;
  originalCount: number;
  escapedCount: number;
}

export interface RecoveryEfforts {
  recapturedCount: number;
  recaptureMethod?: string;
  ongoingEfforts: boolean;
  estimatedRemaining: number;
  lastUpdateDate?: Date;
}

export interface EnvironmentalImpact {
  nearbyWildPopulations: boolean;
  riverSystems: string[];
  assessmentRequired: boolean;
  assessmentStatus?: 'not_started' | 'in_progress' | 'completed';
  assessmentNotes?: string;
}

export interface EscapeReport extends ReportBase {
  reportType: 'escape';
  escapeStatus: EscapeStatus;
  detectedAt: Date;
  reportedAt?: Date;
  contactEmail: string; // varsling.akva@mattilsynet.no
  reportedBy?: string;
  escape: EscapeDetails;
  affectedUnits: AffectedUnit[];
  recovery: RecoveryEfforts;
  environmentalImpact: EnvironmentalImpact;
  preventiveMeasures: string[];
  acknowledgement?: ReportAcknowledgement;
  closedAt?: Date;
  closureNotes?: string;
}

// ============================================================================
// Union Type for All Reports
// ============================================================================

export type RegulatoryReport =
  | SeaLiceReport
  | BiomassReport
  | SmoltReport
  | CleanerFishReport
  | SlaughterReport
  | PlannedSlaughterReport      // Mattilsynet API: /api/slakt/v1/planlagt
  | ExecutedSlaughterReport     // Mattilsynet API: /api/slakt/v1/utfort
  | WelfareEventReport
  | DiseaseOutbreakReport
  | EscapeReport;

// ============================================================================
// Report Tab Configuration
// ============================================================================

export interface ReportTabConfig {
  id: ReportType;
  label: string;
  path: string;
  icon: string;
  description: string;
  deadline: 'weekly' | 'monthly' | 'immediate' | 'event-based';
  priority: ReportPriority;
  formType: 'modal' | 'wizard';
  contactEmail?: string;
}

// ============================================================================
// Report Filter Types
// ============================================================================

export interface ReportFilter {
  siteId?: string;
  status?: ReportStatus[];
  dateFrom?: Date;
  dateTo?: Date;
  reportType?: ReportType;
}

export interface ReportListOptions {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

// ============================================================================
// Report Stats
// ============================================================================

export interface ReportStats {
  pending: number;
  draft: number;
  submitted: number;
  overdue: number;
  total: number;
  byType: Record<ReportType, number>;
}
