/**
 * FileReferenceProvider
 *
 * Contract that every domain module implementing document
 * storage must satisfy so the nightly orphan-cleanup cron
 * (phase 6.2.3) can collect the union of "live" MinIO paths
 * across the whole service. A path that appears in ANY
 * provider's output is protected from deletion; a path absent
 * from every provider AND older than the safety threshold is
 * deleted.
 *
 * # Why a contract instead of a metadata walk?
 *
 * TypeORM entity metadata exposes column names but not JSONB-
 * embedded references. Farm-service has at least two shapes
 * today:
 *
 *   - `BatchDocument.storagePath` — a flat VARCHAR column
 *   - `Chemical.documents` — a JSONB array `[{ url }]`
 *
 * A generic walker that handles both would need per-entity
 * configuration anyway. Making the contract explicit keeps
 * ownership with the module that knows its own shape: a new
 * document-holding entity adds a provider, no central
 * registry to update.
 *
 * # Implementation notes
 *
 *   - `collectLivePaths()` MUST return every path the provider's
 *     data layer currently considers reachable. Soft-deleted
 *     rows count as reachable if the module expects to later
 *     restore them. A path returned by only one of many
 *     providers is still protected — the cleanup service unions.
 *   - The method may be slow (tens of seconds on a large
 *     tenant). Callers always invoke it from a cron, never from
 *     a request path.
 *   - Paths are returned as-is — the SAME string MinIO stored
 *     them under. Any transformation (e.g. stripping the bucket
 *     prefix) belongs in the provider, not the cleanup service.
 *
 * Phase 6.2.3 of the "Farm modülü kalan kör noktalar" plan.
 */
export interface FileReferenceProvider {
  /** Human-readable label for logs and audit trails. */
  readonly name: string;

  /** Enumerate every MinIO path currently referenced by a live domain row. */
  collectLivePaths(): Promise<string[]>;
}

/** Injection token for the `FileReferenceProvider[]` multi-provider array. */
export const FILE_REFERENCE_PROVIDERS = Symbol('FILE_REFERENCE_PROVIDERS');
