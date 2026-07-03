/**
 * Regulatory identity resolver — the SSoT for the Mattilsynet identity block
 * shared by EVERY report tab (the 5 REST reports + the 3 immediate/varsling
 * reports). FARM-HIGH-128: the REST tabs used to hand-roll
 * `lokalitetsnummer: mapping?.lokalitetsnummer || 0`, silently shipping a 0 when
 * no mapping resolved; routing them through this fail-closed resolver instead
 * makes an un-mapped site an actionable error, never an invalid submission.
 *
 * WHY a shared helper — all tabs need the SAME Mattilsynet identity
 * block (organisasjonsnummer + per-site lokalitetsnummer + contact person)
 * resolved from RegulatorySettings, plus the SAME "is the tenant configured to
 * submit?" guard. Duplicating this across three tabs would let the validation
 * drift. This is reuse of the single RegulatorySettings SSoT, not a parallel
 * abstraction.
 *
 * If the tenant has not configured the company org-number, the site→locality
 * mapping, or the default contact, submission CANNOT proceed honestly — the
 * report would be rejected by Mattilsynet. The helper throws a descriptive,
 * actionable error so the modal surfaces it instead of faking success.
 */
import type { RegulatorySettings } from '../../../hooks/useRegulatory';

export interface RegulatoryIdentity {
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  kontaktperson: {
    navn: string;
    epost: string;
    /** Always a string (empty when the tenant configured no phone) so both the
     *  REST report inputs (required) and the varsling inputs (optional) accept it. */
    telefonnummer: string;
  };
  siteManagerEmail?: string;
}

/**
 * Thrown when the tenant's regulatory settings are incomplete for an
 * immediate report. The message is operator-facing and lists exactly what to
 * configure under Setup → Regulatory.
 */
export class RegulatoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegulatoryConfigError';
  }
}

/**
 * Resolve the Mattilsynet identity block for a given site, or throw a
 * RegulatoryConfigError describing the missing configuration.
 *
 * @param settings the tenant's regulatory settings (may be undefined if not loaded)
 * @param siteId   the site the report is for — used to look up its lokalitetsnummer
 */
export function buildRegulatoryIdentity(
  settings: RegulatorySettings | undefined,
  siteId: string,
): RegulatoryIdentity {
  if (!settings) {
    throw new RegulatoryConfigError(
      'Regulatory settings are not loaded yet. Please wait a moment and try again.',
    );
  }

  const missing: string[] = [];

  const organisasjonsnummer = settings.organisationNumber;
  if (!organisasjonsnummer) {
    missing.push('company organisation number');
  }

  const mapping = settings.siteLocalityMappings?.find((m) => m.siteId === siteId);
  if (!mapping) {
    missing.push(`a locality number (lokalitetsnummer) for this site`);
  }

  const navn = settings.defaultContactName;
  const epost = settings.defaultContactEmail;
  if (!navn || !epost) {
    missing.push('a default contact name and email');
  }

  if (missing.length > 0) {
    throw new RegulatoryConfigError(
      `Cannot submit to Mattilsynet — missing ${missing.join(', ')}. ` +
        `Configure these under Setup → Regulatory before reporting.`,
    );
  }

  // All four checks above narrow these to defined; the non-null assertions are
  // sound because `missing.length === 0` proves each value is present.
  return {
    organisasjonsnummer: organisasjonsnummer!,
    lokalitetsnummer: mapping!.lokalitetsnummer,
    kontaktperson: {
      navn: navn!,
      epost: epost!,
      telefonnummer: settings.defaultContactPhone ?? '',
    },
    siteManagerEmail: settings.defaultContactEmail,
  };
}
