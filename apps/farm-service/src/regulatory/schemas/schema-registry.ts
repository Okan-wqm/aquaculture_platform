/**
 * Official Mattilsynet JSON Schema registry.
 *
 * Loads and compiles the five official report schemas (schemas/official/*.json)
 * with Ajv at module initialisation — a malformed schema fails the process at
 * boot (and every test run), never at submit time. The schemas are the in-repo
 * SSoT for the regulator's wire format (docs/integrations/mattilsynet-reporting-api.md);
 * refreshing them from the live swagger is tracked as RPT-017.
 */
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import { RegulatoryReportType } from '../entities/regulatory-report.entity';

import lakselusSchema from './official/lakselus-v1.schema.json';
import rensefiskSchema from './official/rensefisk-v1.schema.json';
import settefiskSchema from './official/settefisk-v1.schema.json';
import slaktPlanlagtSchema from './official/slakt-planlagt-v1.schema.json';
import slaktUtfortSchema from './official/slakt-utfort-v1.schema.json';

/** The five report types submitted over the Mattilsynet REST API. */
export type MattilsynetRestReportType =
  | RegulatoryReportType.SEA_LICE
  | RegulatoryReportType.CLEANER_FISH
  | RegulatoryReportType.SMOLT
  | RegulatoryReportType.SLAUGHTER_PLANNED
  | RegulatoryReportType.SLAUGHTER_EXECUTED;

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
// Vendor-extension marker: false until the schema has been diffed against the
// live Mattilsynet swagger (RPT-017). Metadata only — no validation semantics.
ajv.addKeyword({ keyword: 'x-verified', schemaType: 'boolean' });

const validators: Record<MattilsynetRestReportType, ValidateFunction> = {
  [RegulatoryReportType.SEA_LICE]: ajv.compile(lakselusSchema),
  [RegulatoryReportType.CLEANER_FISH]: ajv.compile(rensefiskSchema),
  [RegulatoryReportType.SMOLT]: ajv.compile(settefiskSchema),
  [RegulatoryReportType.SLAUGHTER_PLANNED]: ajv.compile(slaktPlanlagtSchema),
  [RegulatoryReportType.SLAUGHTER_EXECUTED]: ajv.compile(slaktUtfortSchema),
};

export function getOfficialSchemaValidator(
  reportType: MattilsynetRestReportType,
): ValidateFunction {
  return validators[reportType];
}

export function isMattilsynetRestReportType(
  reportType: RegulatoryReportType,
): reportType is MattilsynetRestReportType {
  return reportType in validators;
}
