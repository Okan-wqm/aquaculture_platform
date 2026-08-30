/**
 * Farm GraphQL Enum-Value Casing Parity Invariant (FARM-MEDIUM-166)
 * ============================================================================
 *
 * The farm-module frontend hand-writes TypeScript union types that mirror the
 * farm-service GraphQL enums (it is not yet codegen-backed like aquamobil). When
 * the two drift in CASING, the wire silently breaks: NestJS `registerEnumType`
 * exposes each enum's KEYS as the GraphQL wire values, so a FE literal in the
 * enum's lowercase internal VALUE form fails enum coercion BEFORE the resolver.
 * That is exactly what killed two legally-immediate report flows in
 * FARM-CRITICAL-165 (welfare/disease varsling sent `welfare_impact`/`high`/
 * `suspected`; the SDL wanted `WELFARE_IMPACT`/`HIGH`/`SUSPECTED`) and hid the
 * "Approve & Submit" affordance (draft status compared against `ready`, wire is
 * `READY`).
 *
 * Root-cause guard (tier-3, make-it-detectable): every enum in the registry
 * below has its backend KEY set extracted from source and asserted EQUAL,
 * case-sensitively, to the frontend union it mirrors. Any casing/shape drift is
 * now a CI failure instead of a review miss. The durable tier-1 fix remains a
 * codegen-backed FE (tracked under FARM-MEDIUM-166); until that lands, this pins
 * the vocabularies the FE actually sends.
 *
 * Adding an enum pair here is the required step when a new hand-written FE union
 * mirrors a backend GraphQL enum.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');

interface EnumParityPair {
  /** Human label for failure output. */
  label: string;
  backend: { file: string; enumName: string };
  frontend: { file: string; typeName: string };
}

const BE = 'apps/farm-service/src/regulatory';
const FE = 'web/modules/farm-module/src';

/**
 * Each backend GraphQL enum ↔ the hand-written FE union that mirrors its WIRE
 * vocabulary (the enum KEYS). Every entry must name a real backend
 * `registerEnumType` enum and a real FE `export type … = '…' | '…'` union.
 */
const ENUM_PARITY: readonly EnumParityPair[] = [
  {
    label: 'ReportDraftStatus (scheduled draft lifecycle)',
    backend: {
      file: `${BE}/entities/regulatory-report-draft.entity.ts`,
      enumName: 'ReportDraftStatus',
    },
    frontend: { file: `${FE}/hooks/useReportDeadlines.ts`, typeName: 'ReportDraftStatusValue' },
  },
  {
    label: 'ReportPrefillType (assembled draft type)',
    backend: { file: `${BE}/assembly/report-assembly.service.ts`, enumName: 'ReportPrefillType' },
    frontend: { file: `${FE}/hooks/useReportPrefill.ts`, typeName: 'ReportPrefillTypeValue' },
  },
  {
    label: 'ReportFieldProvenance (RECORDS/SENSOR/MANUAL_REQUIRED)',
    backend: { file: `${BE}/assembly/provenance.types.ts`, enumName: 'ReportFieldProvenance' },
    frontend: { file: `${FE}/hooks/useReportPrefill.ts`, typeName: 'ReportFieldProvenanceValue' },
  },
  {
    label: 'RegulatoryReportType (persisted submission report type)',
    backend: {
      file: `${BE}/entities/regulatory-report.entity.ts`,
      enumName: 'RegulatoryReportType',
    },
    frontend: {
      file: `${FE}/hooks/useRegulatoryReports.ts`,
      typeName: 'RegulatoryReportTypeValue',
    },
  },
  {
    label: 'WelfareEventTypeInput (welfare varsling event type)',
    backend: {
      file: `${BE}/dto/regulatory-varsling-inputs.dto.ts`,
      enumName: 'WelfareEventTypeInput',
    },
    frontend: { file: `${FE}/hooks/useRegulatory.ts`, typeName: 'WelfareEventTypeValue' },
  },
  {
    label: 'WelfareSeverityInput (welfare varsling severity)',
    backend: {
      file: `${BE}/dto/regulatory-varsling-inputs.dto.ts`,
      enumName: 'WelfareSeverityInput',
    },
    frontend: { file: `${FE}/hooks/useRegulatory.ts`, typeName: 'WelfareSeverityValue' },
  },
  {
    label: 'DiseaseCategoryInput (disease varsling category A/C/F)',
    backend: {
      file: `${BE}/dto/regulatory-varsling-inputs.dto.ts`,
      enumName: 'DiseaseCategoryInput',
    },
    frontend: { file: `${FE}/hooks/useRegulatory.ts`, typeName: 'DiseaseCategoryValue' },
  },
  {
    label: 'DiseaseConfirmationInput (disease varsling confirmation)',
    backend: {
      file: `${BE}/dto/regulatory-varsling-inputs.dto.ts`,
      enumName: 'DiseaseConfirmationInput',
    },
    frontend: { file: `${FE}/hooks/useRegulatory.ts`, typeName: 'DiseaseConfirmationValue' },
  },
];

/** Extract the KEYS of a TS `export enum <name> { KEY = '…', … }` block. */
function extractBackendEnumKeys(file: string, enumName: string): string[] {
  const src = readFileSync(join(REPO_ROOT, file), 'utf8');
  const start = new RegExp(`export enum ${enumName}\\s*\\{`).exec(src);
  if (!start) {
    throw new Error(`Backend enum ${enumName} not found in ${file}`);
  }
  const bodyStart = start.index + start[0].length;
  const bodyEnd = src.indexOf('}', bodyStart);
  if (bodyEnd === -1) {
    throw new Error(`Backend enum ${enumName} in ${file} is not closed`);
  }
  const body = src.slice(bodyStart, bodyEnd);
  const keys: string[] = [];
  // Each member is `KEY = '…',` (or `KEY,`). The KEY is the leading identifier —
  // that is the GraphQL WIRE value NestJS exposes.
  const memberRe = /(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(body)) !== null) {
    keys.push(m[1]!);
  }
  return keys;
}

/** Extract the string-literal members of a FE `export type <name> = 'A' | 'B';` union. */
function extractFrontendUnionMembers(file: string, typeName: string): string[] {
  const src = readFileSync(join(REPO_ROOT, file), 'utf8');
  const start = new RegExp(`export type ${typeName}\\s*=`).exec(src);
  if (!start) {
    throw new Error(`Frontend union type ${typeName} not found in ${file}`);
  }
  const bodyStart = start.index + start[0].length;
  const bodyEnd = src.indexOf(';', bodyStart);
  if (bodyEnd === -1) {
    throw new Error(`Frontend union type ${typeName} in ${file} has no terminating semicolon`);
  }
  const body = src.slice(bodyStart, bodyEnd);
  const members: string[] = [];
  const literalRe = /'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(body)) !== null) {
    members.push(m[1]!);
  }
  return members;
}

describe('farm-module ↔ farm-service GraphQL enum casing parity (FARM-MEDIUM-166)', () => {
  it('the registry is non-empty (guards against silent extractor rot)', () => {
    expect(ENUM_PARITY.length).toBeGreaterThanOrEqual(8);
  });

  it.each(ENUM_PARITY)(
    'FE union matches backend enum wire keys exactly: $label',
    ({ backend, frontend }) => {
      const beKeys = extractBackendEnumKeys(backend.file, backend.enumName).sort();
      const feMembers = extractFrontendUnionMembers(frontend.file, frontend.typeName).sort();

      expect(beKeys.length).toBeGreaterThan(0);
      expect(feMembers.length).toBeGreaterThan(0);
      // Case-SENSITIVE equality — the whole point is to catch casing drift.
      expect(feMembers).toEqual(beKeys);
    },
  );
});
