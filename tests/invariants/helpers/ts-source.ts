/**
 * Comment-stripping for source-text invariants.
 *
 * A spec that greps migration text for a construct will otherwise match the
 * construct being DESCRIBED in a docblock. That is not hypothetical: correcting
 * MSG-HIGH-077 meant writing `pinSearchPath(queryRunner, 'messaging')` into two
 * docblocks to explain why it must not be called, which a naive grep reads as
 * two fresh violations.
 *
 * Regex-based stripping is not good enough — `//` and `/*` occur inside SQL
 * template literals — so the implementation walks the source tracking string,
 * template and comment state, and blanks comment bodies while preserving
 * offsets so a reported index still points at the right place in the original
 * file.
 *
 * The one definition lives in `tools/gates/tenant-aware-migration-ddl.ts`
 * (moved there by ARIA-MEDIUM-588: the tenant-aware DDL guard classifies with
 * it internally, and a gate-side copy plus a spec-side copy could drift).
 * This module re-exports it for the specs that consume the helper.
 */
export { stripComments } from '../../../tools/gates/tenant-aware-migration-ddl';
