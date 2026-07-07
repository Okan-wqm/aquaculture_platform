/**
 * Official Mattilsynet schema layer — public surface.
 *
 * Import from here (not the individual modules) so the boundary between
 * the schema registry, the brand, and their consumers stays a single,
 * greppable seam.
 */
export {
  getOfficialSchemaValidator,
  isMattilsynetRestReportType,
  MattilsynetRestReportType,
} from './schema-registry';
export type { ValidatedPayload } from './validated-payload';
