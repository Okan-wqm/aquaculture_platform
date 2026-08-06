/**
 * The AquaMobil v4 UI kit.
 *
 * Every primitive here is token-only — semantic utilities only, no per-theme
 * variant classes and no raw palette — and density-aware, so a screen built out
 * of these is correct in all three themes and grows under Gloves without the
 * page having to know either thing happened.
 *
 * Import from '@/components/ui' rather than the individual files — the barrel is
 * the seam that lets a primitive be split or renamed without touching callers.
 */
export { Button, type ButtonProps } from './Button';
export { Card, CardDivider, type CardProps } from './Card';
export { CapacityMeter, type CapacityMeterProps } from './CapacityMeter';
export { Chip, StatusDot, type ChipProps } from './Chip';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { HoldToConfirm, type HoldToConfirmProps } from './HoldToConfirm';
export { IconButton, type IconButtonProps } from './IconButton';
export { ListRow, type ListRowProps, type RowTone } from './ListRow';
export { NumPad, type NumPadProps } from './NumPad';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './SegmentedControl';
export { Sheet, type SheetProps } from './Sheet';
export { Skeleton, type SkeletonProps } from './Skeleton';
export { SparkBars, type SparkBarsProps } from './SparkBars';
export { StatTile } from './StatTile';
export { TypeTile, type LogType, type TypeTileProps } from './TypeTile';
