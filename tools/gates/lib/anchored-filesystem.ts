/**
 * Production-safe façade for the descriptor-anchored filesystem kernel.
 *
 * The kernel also owns one process-owned fixture trust boundary. That capability is deliberately
 * absent here and can only cross the closed anchored-filesystem.fixture module.
 */
export {
  AnchoredFilesystemError,
  HermeticExecutableExecutionTimeoutError,
  anchoredPathGeneration,
  assertAnchoredDirectoryChainCurrent,
  assertAnchoredDirectoryChainIdentityCurrent,
  assertStableDirectoryContentGenerationCurrent,
  assertStableDirectoryCurrent,
  assertStablePathKindCurrent,
  assertStableRegularFileCurrent,
  closeAnchoredDirectoryChain,
  decodeFatalUtf8,
  defineHermeticExecutableExecutionPolicyV1,
  observeAnchoredPathKind,
  observeStableDirectory,
  observeStablePathKind,
  observeStableRegularFile,
  openAnchoredDirectoryChain,
  openHermeticExecutableAuthority,
  sameAnchoredDirectoryIdentity,
  sameAnchoredPathGeneration,
  sameBigIntFileObservation,
  sameStableParentIdentities,
} from './anchored-filesystem.kernel';

export type {
  AnchoredDirectoryChainV1,
  AnchoredDirectoryComponentV1,
  AnchoredFilesystemErrorCode,
  AnchoredPathGenerationV1,
  AnchoredPathKindV1,
  HermeticExecutableAttestationV1,
  HermeticExecutableAuthorityV1,
  HermeticExecutableContractV1,
  HermeticExecutableExecutionPhaseV1,
  HermeticExecutableExecutionPolicyV1,
  StableDirectoryEntryV1,
  StableDirectoryObservationV1,
  StablePathKindObservationV1,
  StableRegularFileObservationV1,
} from './anchored-filesystem.kernel';
