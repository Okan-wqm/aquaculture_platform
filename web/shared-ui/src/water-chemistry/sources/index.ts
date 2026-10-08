/**
 * Water-chemistry sources — where each input of a calculation comes from at a
 * measurement point, and why it cannot (shared by the farm binding UI and the
 * sensor monitoring view; presentation + pure TS, no data hooks).
 */
export * from './operations';
export * from './pointRef';
export * from './problems';
export * from './inputs-adapter';
export * from './quantities';
export * from './fixPaths';
export { ProblemChips } from './ProblemChips';
export type { ProblemChipsProps } from './ProblemChips';
export { ParameterSourceTile, formatAge } from './ParameterSourceTile';
export type { ParameterSourceTileProps, SourceTrend } from './ParameterSourceTile';
export { FieldProvenanceChip } from './FieldProvenanceChip';
export type { FieldProvenanceChipProps } from './FieldProvenanceChip';
export { TimeSparkline } from './TimeSparkline';
export type { TimeSparklineProps, TrendPoint } from './TimeSparkline';
