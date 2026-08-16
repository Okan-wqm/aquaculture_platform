/**
 * Narrow, side-effect-free schema-drift inspection surface.
 *
 * Dev-only tooling imports this entry point instead of the database composition
 * barrel, so a metadata scan cannot acquire migration runners, event contracts,
 * Nest modules, or domain-specific contract graphs as accidental capabilities.
 */
export {
  getEncryptedAtRestMetadata,
  type EncryptedAtRestMetadata,
} from './encrypted-at-rest.decorator';
export {
  expectedEntityDbType,
  isUuidTypeDrift,
  normalizeInformationSchemaType,
} from './schema-drift/type-normalization';
export {
  compareForeignKeyPresence,
  type ForeignKeyPresenceDrift,
} from './schema-drift/foreign-key-presence';
export { isTenantDeltaAllowed } from './tenant-fanout.decorator';
