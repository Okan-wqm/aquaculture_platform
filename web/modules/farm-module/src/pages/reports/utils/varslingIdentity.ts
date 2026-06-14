/**
 * Varsling identity resolver — shared by the three immediate-report tabs
 * (welfare / escape / disease).
 *
 * WHY a shared helper — all three tabs need the SAME Mattilsynet identity
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

export interface VarslingIdentity {
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  kontaktperson: {
    navn: string;
    epost: string;
    telefonnummer?: string;
  };
  siteManagerEmail?: string;
}

/**
 * Thrown when the tenant's regulatory settings are incomplete for an
 * immediate report. The message is operator-facing and lists exactly what to
 * configure under Setup → Regulatory.
 */
export class VarslingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VarslingConfigError';
  }
}

/**
 * Resolve the Mattilsynet identity block for a given site, or throw a
 * VarslingConfigError describing the missing configuration.
 *
 * @param settings the tenant's regulatory settings (may be undefined if not loaded)
 * @param siteId   the site the report is for — used to look up its lokalitetsnummer
 */
export function buildVarslingIdentity(
  settings: RegulatorySettings | undefined,
  siteId: string,
): VarslingIdentity {
  if (!settings) {
    throw new VarslingConfigError(
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
    throw new VarslingConfigError(
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
      telefonnummer: settings.defaultContactPhone,
    },
    siteManagerEmail: settings.defaultContactEmail,
  };
}
