/**
 * Greenhouse dashboard: a zone row's shape.
 *
 * WHY only a shape: hydroponics-service keeps no greenhouse zones, nutrient
 * readings or dosing state (PRODUCT-MEDIUM-001), so the Site status table of
 * this dashboard renders its sample rows through MockPreview. The shape is
 * the design's — EC max against its target, pH, air temperature against its
 * target, dosing — so the real rows can take its place.
 */
export interface GreenhouseZoneRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly ecMax: number;
  readonly ecTarget: readonly [number, number];
  readonly ph: number;
  readonly airC: number;
  readonly airTarget: readonly [number, number];
  readonly dosing: 'running' | 'paused';
}
