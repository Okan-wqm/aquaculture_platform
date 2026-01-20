/**
 * Regulatory Report Input DTOs
 *
 * GraphQL input types for submitting regulatory reports to Mattilsynet.
 * ALIGNED WITH OFFICIAL MATTILSYNET API SCHEMAS.
 *
 * API Documentation: https://innrapportering-api.fisk.mattilsynet.io/docs/
 *
 * @module Regulatory/DTO
 */
import { InputType, Field, Float, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsDateString,
  IsArray,
  ValidateNested,
  IsEnum,
  Min,
  Max,
  IsEmail,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============================================================================
// Enums - Aligned with Mattilsynet API
// ============================================================================

// --- Lakselus (Sea Lice) Enums - ALIGNED WITH OFFICIAL API ---

export enum IkkeMedikamentellBehandlingType {
  TERMISK_BEHANDLING = 'TERMISK_BEHANDLING',
  MEKANISK_BEHANDLING = 'MEKANISK_BEHANDLING',
  FERSKVANNSBEHANDLING = 'FERSKVANNSBEHANDLING',
  ANNEN_BEHANDLING = 'ANNEN_BEHANDLING',
}

export enum MedikamentellBehandlingType {
  FORBEHANDLING = 'FORBEHANDLING',
  BADEBEHANDLING = 'BADEBEHANDLING',
  ANNEN_BEHANDLING = 'ANNEN_BEHANDLING',
}

export enum VirkestoffType {
  AZAMETHIPHOS = 'AZAMETHIPHOS',
  CYPERMETHRIN = 'CYPERMETHRIN',
  DELTAMETHRIN = 'DELTAMETHRIN',
  IMIDAKLOPRID = 'IMIDAKLOPRID',
  HYDROGENPEROKSID = 'HYDROGENPEROKSID',
  DIFLUBENZURON = 'DIFLUBENZURON',
  EMAMECTIN_BENZOAT = 'EMAMECTIN_BENZOAT',
  TEFLUBENZURON = 'TEFLUBENZURON',
  ANNET_VIRKESTOFF = 'ANNET_VIRKESTOFF',
}

export enum StyrkeEnhet {
  MILLIGRAM_PER_GRAM = 'MILLIGRAM_PER_GRAM',
  MILLIGRAM_PER_MILLILITER = 'MILLIGRAM_PER_MILLILITER',
  GRAM_PER_KILO = 'GRAM_PER_KILO',
  MILLIGRAM_PER_KILO = 'MILLIGRAM_PER_KILO',
  PROSENT = 'PROSENT',
}

export enum MengdeEnhet {
  GRAM = 'GRAM',
  KILO = 'KILO',
  TONN = 'TONN',
  LITER = 'LITER',
}

export enum ResistensType {
  AZAMETHIPHOS = 'AZAMETHIPHOS',
  CYPERMETHRIN = 'CYPERMETHRIN',
  DELTAMETHRIN = 'DELTAMETHRIN',
  IMIDAKLOPRID = 'IMIDAKLOPRID',
  HYDROGENPEROKSID = 'HYDROGENPEROKSID',
  DIFLUBENZURON = 'DIFLUBENZURON',
  EMAMECTIN_BENZOAT = 'EMAMECTIN_BENZOAT',
  TEFLUBENZURON = 'TEFLUBENZURON',
  FERSKVANNSBEHANDLING = 'FERSKVANNSBEHANDLING',
  ANNEN_RESISTENS = 'ANNEN_RESISTENS',
}

// Resistance cause enum - REQUIRED for MistankeOmResistensDto
export enum ResistensAarsakType {
  BIOESSAY = 'BIOESSAY',
  NEDSATT_BEHANDLINGSEFFEKT = 'NEDSATT_BEHANDLINGSEFFEKT',
  SITUASJONEN_I_OMRAADET = 'SITUASJONEN_I_OMRÅDET',
  ANNEN_AARSAK = 'ANNEN_ÅRSAK',
}

export enum Testresultat {
  FOLSOM = 'FØLSOM',
  NEDSATT_FOLSOMHET = 'NEDSATT_FØLSOMHET',
  RESISTENS = 'RESISTENS',
}

// --- Rensefisk (Cleaner Fish) Enums ---

export enum CleanerFishSpeciesCode {
  USB = 'USB',  // Rognkjeks (Lumpfish)
  BER = 'BER',  // Berggylt (Ballan Wrasse)
  GRO = 'GRO',  // Grønngylt (Corkwing Wrasse)
  BNB = 'BNB',  // Bergnebb (Goldsinny Wrasse)
}

// Cleaner fish origin - ALIGNED WITH OFFICIAL RensefiskOpprinnelse
export enum CleanerFishOpprinnelse {
  UKJENT = 'UKJENT',
  VILLFANGET = 'VILLFANGET',
  OPPDRETTET = 'OPPDRETTET',
  VILLFANGET_OG_OPPDRETTET = 'VILLFANGET_OG_OPPDRETTET',
}

// Register all enums for GraphQL
registerEnumType(IkkeMedikamentellBehandlingType, { name: 'IkkeMedikamentellBehandlingType' });
registerEnumType(MedikamentellBehandlingType, { name: 'MedikamentellBehandlingType' });
registerEnumType(VirkestoffType, { name: 'VirkestoffType' });
registerEnumType(StyrkeEnhet, { name: 'StyrkeEnhet' });
registerEnumType(MengdeEnhet, { name: 'MengdeEnhet' });
registerEnumType(ResistensType, { name: 'ResistensType' });
registerEnumType(ResistensAarsakType, { name: 'ResistensAarsakType' });
registerEnumType(Testresultat, { name: 'Testresultat' });
registerEnumType(CleanerFishSpeciesCode, { name: 'CleanerFishSpeciesCode' });
registerEnumType(CleanerFishOpprinnelse, { name: 'CleanerFishOpprinnelse' });

// ============================================================================
// Common Types - Aligned with Mattilsynet API
// ============================================================================

/**
 * Contact person - Required object structure for all Mattilsynet reports
 */
@InputType()
export class KontaktpersonInput {
  @Field({ description: 'Contact person name' })
  @IsNotEmpty()
  @IsString()
  navn: string;

  @Field({ description: 'Contact person email' })
  @IsNotEmpty()
  @IsEmail()
  epost: string;

  @Field({ description: 'Contact person phone number (e.g., +4798989898)' })
  @IsNotEmpty()
  @IsString()
  telefonnummer: string;
}

/**
 * Base input for all regulatory reports
 * IMPORTANT: lokalitetsnummer is NUMBER not string per Mattilsynet API
 */
@InputType()
export class RegulatoryBaseInput {
  @Field({ description: 'Client reference - unique identifier for the submission (UUID)' })
  @IsNotEmpty()
  @IsString()
  klientReferanse: string;

  @Field({ description: 'Norwegian organization number (9 digits)' })
  @IsNotEmpty()
  @IsString()
  organisasjonsnummer: string;

  @Field(() => Int, { description: 'Site/Locality registration number (NUMBER, not string!)' })
  @IsNotEmpty()
  @IsNumber()
  lokalitetsnummer: number;

  @Field(() => KontaktpersonInput, { description: 'Contact person (required object with navn, epost, telefonnummer)' })
  @ValidateNested()
  @Type(() => KontaktpersonInput)
  kontaktperson: KontaktpersonInput;
}

// ============================================================================
// Sea Lice (Lakselus) Report - CORRECTED to match Mattilsynet API
// ============================================================================

/**
 * Lice counting data - Single object, NOT array
 */
@InputType()
export class LusetellingInput {
  @Field(() => Float, { description: 'Adult female lice per fish' })
  @IsNumber()
  @Min(0)
  voksneHunnlus: number;

  @Field(() => Float, { description: 'Mobile lice per fish' })
  @IsNumber()
  @Min(0)
  bevegeligeLus: number;

  @Field(() => Float, { description: 'Attached lice stages per fish' })
  @IsNumber()
  @Min(0)
  fastsittendeLus: number;
}

/**
 * Non-medicated treatment
 */
@InputType()
export class IkkeMedikamentellBehandlingInput {
  @Field(() => IkkeMedikamentellBehandlingType, { description: 'Treatment type' })
  @IsEnum(IkkeMedikamentellBehandlingType)
  type: IkkeMedikamentellBehandlingType;

  @Field({ description: 'Was treatment performed before lice counting?' })
  @IsBoolean()
  gjennomfortForTelling: boolean;

  @Field({ description: 'Was entire site treated?' })
  @IsBoolean()
  heleLokaliteten: boolean;

  @Field(() => Int, { nullable: true, description: 'Number of cages treated (if not entire site)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  antallMerder?: number;

  @Field({ nullable: true, description: 'Description/notes about treatment' })
  @IsOptional()
  @IsString()
  beskrivelse?: string;
}

/**
 * Active ingredient strength
 */
@InputType()
export class VirkestoffStyrkeInput {
  @Field(() => Float, { description: 'Strength value' })
  @IsNumber()
  @Min(0)
  verdi: number;

  @Field(() => StyrkeEnhet, { description: 'Strength unit' })
  @IsEnum(StyrkeEnhet)
  enhet: StyrkeEnhet;
}

/**
 * Active ingredient amount
 */
@InputType()
export class VirkestoffMengdeInput {
  @Field(() => Float, { description: 'Amount value' })
  @IsNumber()
  @Min(0)
  verdi: number;

  @Field(() => MengdeEnhet, { description: 'Amount unit' })
  @IsEnum(MengdeEnhet)
  enhet: MengdeEnhet;
}

/**
 * Active ingredient details
 */
@InputType()
export class VirkestoffInput {
  @Field(() => VirkestoffType, { description: 'Active ingredient type' })
  @IsEnum(VirkestoffType)
  type: VirkestoffType;

  @Field(() => VirkestoffStyrkeInput, { nullable: true, description: 'Concentration/strength' })
  @IsOptional()
  @ValidateNested()
  @Type(() => VirkestoffStyrkeInput)
  styrke?: VirkestoffStyrkeInput;

  @Field(() => VirkestoffMengdeInput, { nullable: true, description: 'Amount used' })
  @IsOptional()
  @ValidateNested()
  @Type(() => VirkestoffMengdeInput)
  mengde?: VirkestoffMengdeInput;

  @Field({ nullable: true, description: 'Description if type is ANNET' })
  @IsOptional()
  @IsString()
  annetVirkestoff?: string;
}

/**
 * Medicated treatment
 */
@InputType()
export class MedikamentellBehandlingInput {
  @Field(() => MedikamentellBehandlingType, { description: 'Treatment type' })
  @IsEnum(MedikamentellBehandlingType)
  type: MedikamentellBehandlingType;

  @Field({ description: 'Was treatment performed before lice counting?' })
  @IsBoolean()
  gjennomfortForTelling: boolean;

  @Field({ description: 'Was entire site treated?' })
  @IsBoolean()
  heleLokaliteten: boolean;

  @Field(() => Int, { nullable: true, description: 'Number of cages treated (if not entire site)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  antallMerder?: number;

  @Field(() => VirkestoffInput, { description: 'Active ingredient details' })
  @ValidateNested()
  @Type(() => VirkestoffInput)
  virkestoff: VirkestoffInput;

  @Field({ nullable: true, description: 'Description - only set when type is ANNEN_BEHANDLING' })
  @IsOptional()
  @IsString()
  beskrivelse?: string;
}

/**
 * Combination treatment - ALIGNED WITH OFFICIAL KombinasjonsbehandlingDto
 * Contains arrays of both non-medicated and medicated treatments
 */
@InputType()
export class KombinasjonsbehandlingInput {
  @Field(() => [IkkeMedikamentellBehandlingInput], { nullable: true, description: 'Non-medicated treatments in combination' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IkkeMedikamentellBehandlingInput)
  ikkeMedikamentelleBehandlinger?: IkkeMedikamentellBehandlingInput[];

  @Field(() => [MedikamentellBehandlingInput], { nullable: true, description: 'Medicated treatments in combination' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MedikamentellBehandlingInput)
  medikamentelleBehandlinger?: MedikamentellBehandlingInput[];
}

/**
 * Resistance suspicion - ALIGNED WITH OFFICIAL MistankeOmResistensDto
 * Required fields: resistens, årsak
 */
@InputType()
export class ResistensMistankeInput {
  @Field(() => ResistensType, { description: 'Resistance type suspected (AZAMETHIPHOS, CYPERMETHRIN, etc.)' })
  @IsEnum(ResistensType)
  resistens: ResistensType;

  @Field(() => ResistensAarsakType, { description: 'Cause of resistance suspicion (BIOESSAY, NEDSATT_BEHANDLINGSEFFEKT, etc.)' })
  @IsEnum(ResistensAarsakType)
  aarsak: ResistensAarsakType;

  @Field({ nullable: true, description: 'Description if resistens is ANNEN_RESISTENS' })
  @IsOptional()
  @IsString()
  annenResistens?: string;

  @Field({ nullable: true, description: 'Description if aarsak is ANNEN_AARSAK' })
  @IsOptional()
  @IsString()
  annenAarsak?: string;
}

/**
 * Sensitivity test result
 */
@InputType()
export class FolsomhetsundersokelseInput {
  @Field({ description: 'Test execution date (ISO format)' })
  @IsNotEmpty()
  @IsDateString()
  utfortDato: string;

  @Field({ description: 'Laboratory name' })
  @IsNotEmpty()
  @IsString()
  laboratorium: string;

  @Field(() => ResistensType, { description: 'Resistance type tested' })
  @IsEnum(ResistensType)
  resistens: ResistensType;

  @Field(() => Testresultat, { description: 'Test result' })
  @IsEnum(Testresultat)
  testresultat: Testresultat;
}

/**
 * Sea Lice Report Input - CORRECTED
 * Field names match official Mattilsynet API
 */
@InputType()
export class SubmitSeaLiceReportInput extends RegulatoryBaseInput {
  @Field(() => Int, { description: 'Reporting year' })
  @IsNumber()
  @Min(2020)
  rapporteringsaar: number;

  @Field(() => Int, { description: 'Reporting week number (1-53)' })
  @Min(1)
  @Max(53)
  rapporteringsuke: number;

  @Field(() => Float, { description: 'Sea water temperature (Celsius)' })
  @IsNumber()
  sjotemperatur: number;

  @Field(() => LusetellingInput, { description: 'Lice counting data (single object, NOT array)' })
  @ValidateNested()
  @Type(() => LusetellingInput)
  lusetelling: LusetellingInput;

  @Field(() => [IkkeMedikamentellBehandlingInput], { nullable: true, description: 'Non-medicated treatments' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IkkeMedikamentellBehandlingInput)
  ikkeMedikamentelleBehandlinger?: IkkeMedikamentellBehandlingInput[];

  @Field(() => [MedikamentellBehandlingInput], { nullable: true, description: 'Medicated treatments' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MedikamentellBehandlingInput)
  medikamentelleBehandlinger?: MedikamentellBehandlingInput[];

  @Field(() => [KombinasjonsbehandlingInput], { nullable: true, description: 'Combination treatments' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KombinasjonsbehandlingInput)
  kombinasjonsbehandlinger?: KombinasjonsbehandlingInput[];

  @Field(() => [ResistensMistankeInput], { nullable: true, description: 'Resistance suspicions' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResistensMistankeInput)
  resistensMistanker?: ResistensMistankeInput[];

  @Field(() => [FolsomhetsundersokelseInput], { nullable: true, description: 'Sensitivity test results' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FolsomhetsundersokelseInput)
  folsomhetsundersokelser?: FolsomhetsundersokelseInput[];
}

// ============================================================================
// Smolt (Settefisk) Report - CORRECTED to match Mattilsynet API
// ============================================================================

/**
 * Production unit for smolt report
 * IMPORTANT: Field names match official API
 */
@InputType()
export class ProduksjonsenhetSettefiskInput {
  @Field({ description: 'Tank/unit identifier (karId)' })
  @IsNotEmpty()
  @IsString()
  karId: string;

  @Field({ description: 'Species code (e.g., SAL for salmon)' })
  @IsNotEmpty()
  @IsString()
  artskode: string;

  @Field(() => Float, { description: 'Average weight in grams' })
  @IsNumber()
  @Min(0)
  snittvektGram: number;

  @Field(() => Int, { description: 'Stock count at end of month' })
  @IsNumber()
  @Min(0)
  beholdningVedMaanedsslutt: number;

  @Field(() => Int, { description: 'Number euthanized' })
  @IsNumber()
  @Min(0)
  antallAvlivet: number;

  @Field(() => Int, { description: 'Number died naturally' })
  @IsNumber()
  @Min(0)
  antallSelvdod: number;

  @Field(() => Int, { description: 'Number transferred externally' })
  @IsNumber()
  @Min(0)
  antallFlyttetEksternt: number;
}

/**
 * Smolt Report Input - CORRECTED
 */
@InputType()
export class SubmitSmoltReportInput extends RegulatoryBaseInput {
  @Field(() => Int, { description: 'Reporting month (1-12)' })
  @Min(1)
  @Max(12)
  rapporteringsmaaned: number;

  @Field(() => Int, { description: 'Reporting year' })
  @IsNumber()
  @Min(2020)
  rapporteringsaar: number;

  @Field(() => [ProduksjonsenhetSettefiskInput], { description: 'Production units data' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProduksjonsenhetSettefiskInput)
  produksjonsenheter: ProduksjonsenhetSettefiskInput[];
}

// ============================================================================
// Cleaner Fish (Rensefisk) Report - CORRECTED to match Mattilsynet API
// ============================================================================

/**
 * Stocking data for cleaner fish
 */
@InputType()
export class RensefiskUtsettInput {
  @Field(() => Int, { description: 'Number transferred in from other cages' })
  @IsNumber()
  @Min(0)
  antallFlyttetInn: number;

  @Field(() => Int, { description: 'Number of new fish stocked' })
  @IsNumber()
  @Min(0)
  antallNy: number;
}

/**
 * Removal/mortality data for cleaner fish
 * IMPORTANT: Contains 10+ specific cause fields per Mattilsynet API
 */
@InputType()
export class RensefiskUttakInput {
  @Field(() => Int, { description: 'Euthanized due to disease' })
  @IsNumber()
  @Min(0)
  antallAvlivetSykdom: number;

  @Field(() => Int, { description: 'Euthanized due to injuries' })
  @IsNumber()
  @Min(0)
  antallAvlivetSkader: number;

  @Field(() => Int, { description: 'Euthanized due to emaciation' })
  @IsNumber()
  @Min(0)
  antallAvlivetAvmagret: number;

  @Field(() => Int, { description: 'Euthanized before salmon handling' })
  @IsNumber()
  @Min(0)
  antallAvlivetForestaendeHaandteringAvLaksen: number;

  @Field(() => Int, { description: 'Euthanized due to unfavorable living environment' })
  @IsNumber()
  @Min(0)
  antallAvlivetForestaendeUgunstigLevemiljo: number;

  @Field(() => Int, { description: 'Euthanized - should not be used' })
  @IsNumber()
  @Min(0)
  antallAvlivetSkalIkkeBrukes: number;

  @Field(() => Int, { description: 'Number died naturally' })
  @IsNumber()
  @Min(0)
  antallSelvdod: number;

  @Field(() => Int, { description: 'Number transferred out' })
  @IsNumber()
  @Min(0)
  antallFlyttetUt: number;

  @Field(() => Int, { description: 'Number unaccounted for' })
  @IsNumber()
  @Min(0)
  antallKanIkkeGjoresRedeFor: number;
}

/**
 * Species data within a production unit (cage)
 */
@InputType()
export class RensefiskArtInput {
  @Field(() => CleanerFishSpeciesCode, { description: 'Species code (USB, BER, GRO, BNB)' })
  @IsEnum(CleanerFishSpeciesCode)
  artskode: CleanerFishSpeciesCode;

  @Field(() => CleanerFishOpprinnelse, { description: 'Origin (VILLFANGET/OPPDRETT)' })
  @IsEnum(CleanerFishOpprinnelse)
  opprinnelse: CleanerFishOpprinnelse;

  @Field(() => Int, { description: 'Stock at end of previous month' })
  @IsNumber()
  @Min(0)
  beholdningVedForrigeMaanedsslutt: number;

  @Field(() => RensefiskUtsettInput, { description: 'Stocking data' })
  @ValidateNested()
  @Type(() => RensefiskUtsettInput)
  utsett: RensefiskUtsettInput;

  @Field(() => RensefiskUttakInput, { description: 'Removal/mortality data' })
  @ValidateNested()
  @Type(() => RensefiskUttakInput)
  uttak: RensefiskUttakInput;
}

/**
 * Production unit (cage) for cleaner fish
 */
@InputType()
export class ProduksjonsenhetRensefiskInput {
  @Field({ description: 'Cage identifier' })
  @IsNotEmpty()
  @IsString()
  merdId: string;

  @Field(() => [RensefiskArtInput], { description: 'Species data within cage' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RensefiskArtInput)
  arter: RensefiskArtInput[];
}

/**
 * Cleaner Fish Report Input - CORRECTED
 */
@InputType()
export class SubmitCleanerFishReportInput extends RegulatoryBaseInput {
  @Field(() => Int, { description: 'Reporting month (1-12)' })
  @Min(1)
  @Max(12)
  rapporteringsmaaned: number;

  @Field(() => Int, { description: 'Reporting year' })
  @IsNumber()
  @Min(2020)
  rapporteringsaar: number;

  @Field(() => [String], { nullable: true, description: 'Co-operation organization numbers' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  samdriftOrganisasjonsnumre?: string[];

  @Field({ nullable: true, description: 'Production cycle start date (ISO format)' })
  @IsOptional()
  @IsDateString()
  produksjonssyklusStart?: string;

  @Field(() => Float, { nullable: true, description: 'Dry feed consumption (kg)' })
  @IsOptional()
  @Min(0)
  torrforKg?: number;

  @Field(() => Float, { nullable: true, description: 'Wet feed consumption (kg)' })
  @IsOptional()
  @Min(0)
  vatforKg?: number;

  @Field(() => [ProduksjonsenhetRensefiskInput], { description: 'Production units (cages) data' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProduksjonsenhetRensefiskInput)
  produksjonsenheter: ProduksjonsenhetRensefiskInput[];
}

// ============================================================================
// Slaughter Report Inputs - ALIGNED WITH OFFICIAL MATTILSYNET API
// ============================================================================

/**
 * Weekly slaughter plan per species - UkeplanPerArt
 * Contains planned slaughter amounts for each day of the week
 */
@InputType()
export class UkeplanPerArtInput {
  @Field({ description: 'Species code (FAO 3-letter code, e.g., SAL, RBT)' })
  @IsNotEmpty()
  @IsString()
  artskode: string;

  @Field(() => Int, { nullable: true, description: 'Planned slaughter Monday (gutted weight kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  mandagKg?: number;

  @Field(() => Int, { nullable: true, description: 'Planned slaughter Tuesday (gutted weight kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tirsdagKg?: number;

  @Field(() => Int, { nullable: true, description: 'Planned slaughter Wednesday (gutted weight kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  onsdagKg?: number;

  @Field(() => Int, { nullable: true, description: 'Planned slaughter Thursday (gutted weight kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  torsdagKg?: number;

  @Field(() => Int, { nullable: true, description: 'Planned slaughter Friday (gutted weight kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fredagKg?: number;

  @Field(() => Int, { nullable: true, description: 'Planned slaughter Saturday (gutted weight kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  lordagKg?: number;

  @Field(() => Int, { nullable: true, description: 'Planned slaughter Sunday (gutted weight kg)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  sondagKg?: number;
}

/**
 * Planned slaughter per locality - PlanlagtLokalitetDto
 * Contains organisation number, locality number and weekly plan per species
 */
@InputType()
export class PlannedSlaughterLocalityInput {
  @Field({ description: 'Organization number (9 digits)' })
  @IsNotEmpty()
  @IsString()
  organisasjonsnummer: string;

  @Field(() => Int, { description: 'Locality registration number (10000-99999)' })
  @IsNotEmpty()
  @IsNumber()
  @Min(10000)
  @Max(99999)
  lokalitetsnummer: number;

  @Field(() => [UkeplanPerArtInput], { description: 'Weekly plan per species (at least 1 required)' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UkeplanPerArtInput)
  ukeplanPerArt: UkeplanPerArtInput[];
}

/**
 * Submit Planned Slaughter Report - PlanlagtSlaktRapportDto
 */
@InputType()
export class SubmitPlannedSlaughterInput extends RegulatoryBaseInput {
  @Field(() => Int, { description: 'Week number (1-53)' })
  @Min(1)
  @Max(53)
  uke: number;

  @Field(() => Int, { description: 'Year' })
  @IsNumber()
  @Min(2020)
  aar: number;

  @Field({ description: 'Slaughter facility approval number (1-6 alphanumeric characters)' })
  @IsNotEmpty()
  @IsString()
  godkjenningsnummer: string;

  @Field(() => [PlannedSlaughterLocalityInput], { description: 'Planned slaughters by locality' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlannedSlaughterLocalityInput)
  planlagteLokaliteter: PlannedSlaughterLocalityInput[];
}

/**
 * Quality grades per species - KvalitetsklasserPerArt
 * Contains slaughter amounts by quality grade (gutted weight)
 */
@InputType()
export class KvalitetsklasserPerArtInput {
  @Field({ description: 'Species code (FAO 3-letter code, e.g., SAL, RBT)' })
  @IsNotEmpty()
  @IsString()
  art: string;

  @Field(() => Int, { description: 'Superior quality grade (gutted weight kg)' })
  @IsNumber()
  @Min(0)
  superiorKg: number;

  @Field(() => Int, { description: 'Standard/ordinary quality grade (gutted weight kg)' })
  @IsNumber()
  @Min(0)
  ordinaerKg: number;

  @Field(() => Int, { description: 'Production fish quality grade (gutted weight kg)' })
  @IsNumber()
  @Min(0)
  produksjonsfiskKg: number;

  @Field(() => Int, { description: 'Waste/reject (gutted weight kg)' })
  @IsNumber()
  @Min(0)
  utkastKg: number;
}

/**
 * Executed slaughter per locality - UtførtSlaktDto
 * Contains organisation number, locality number and quality grades per species
 */
@InputType()
export class ExecutedSlaughterLocalityInput {
  @Field({ description: 'Organization number (9 digits)' })
  @IsNotEmpty()
  @IsString()
  organisasjonsnummer: string;

  @Field(() => Int, { description: 'Locality registration number' })
  @IsNotEmpty()
  @IsNumber()
  lokalitetsnummer: number;

  @Field(() => [KvalitetsklasserPerArtInput], { description: 'Quality grades per species' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KvalitetsklasserPerArtInput)
  arter: KvalitetsklasserPerArtInput[];
}

/**
 * Submit Executed Slaughter Report - UtførtSlaktRapportDto
 */
@InputType()
export class SubmitExecutedSlaughterInput extends RegulatoryBaseInput {
  @Field(() => Int, { description: 'Slaughter week number (1-53)' })
  @Min(1)
  @Max(53)
  slakteuke: number;

  @Field(() => Int, { description: 'Slaughter year' })
  @IsNumber()
  @Min(2020)
  slakteaar: number;

  @Field({ description: 'Slaughter facility approval number (1-6 alphanumeric characters)' })
  @IsNotEmpty()
  @IsString()
  godkjenningsnummer: string;

  @Field(() => [ExecutedSlaughterLocalityInput], { description: 'Executed slaughters by locality' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExecutedSlaughterLocalityInput)
  utforteLokaliteter: ExecutedSlaughterLocalityInput[];
}

// ============================================================================
// Response Types
// ============================================================================

@ObjectType()
export class ReportValidationError {
  @Field({ description: 'Field name' })
  felt: string;

  @Field({ description: 'Error message' })
  melding: string;
}

@ObjectType()
export class ReportSubmissionResult {
  @Field({ description: 'Whether the submission was successful' })
  success: boolean;

  @Field({ nullable: true, description: 'Mattilsynet reference number (if successful)' })
  referanse?: string;

  @Field({ nullable: true, description: 'Client reference echoed back' })
  klientReferanse?: string;

  @Field({ nullable: true, description: 'Error message (if failed)' })
  feilmelding?: string;

  @Field(() => [ReportValidationError], { nullable: true, description: 'Validation errors (if any)' })
  valideringsfeil?: ReportValidationError[];
}
