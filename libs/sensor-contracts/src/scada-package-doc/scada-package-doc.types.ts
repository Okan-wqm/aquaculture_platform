/**
 * @module ScadaPackageDoc
 *
 * Wire/persistence contract for the SCADA package document stored in
 * `sensor.scada_packages.package_data` and deployed to the edge.
 *
 * V2 is the first VERSIONED shape (`meta.schemaVersion: 2`). Documents
 * without a `meta.schemaVersion` are legacy V1 and must pass through
 * {@link upcastScadaPackageDoc} before use. V2 additionally:
 *  - carries the full widget shape (`name`, `visible`, `zIndex`,
 *    `permissions`) that the V1-era serializer silently dropped, and
 *  - introduces `config.tagRef` as the canonical widget↔tag binding key
 *    (full `deviceCode/localName` TagRef), superseding the V1 split where
 *    the builder read `config.tagName` and the operator read `config.tagId`.
 *
 * The interfaces deliberately mirror the sensor-module store types
 * (`web/modules/sensor-module/src/types/scada-package.types.ts`) without
 * importing them: the lib defines the PERSISTED contract; the store defines
 * the in-memory editor state.
 */

export const SCADA_PACKAGE_DOC_SCHEMA_VERSION = 2 as const;

export interface WidgetPositionDoc {
  col: number;
  row: number;
  w: number;
  h: number;
}

export interface WidgetDoc {
  id: string;
  widgetType: string;
  position: WidgetPositionDoc;
  /**
   * Widget configuration bag. `tagRef` (canonical, full TagRef) is the
   * binding key going forward; legacy keys (`tagName`, `tag`, `tagId`)
   * survive until the Faz 6 backfill so old readers keep working.
   */
  config: Record<string, unknown> & { tagRef?: string };
  name?: string;
  groupId?: string | null;
  locked?: boolean;
  visible?: boolean;
  zIndex?: number;
  permissions?: Record<string, unknown>;
  animations?: unknown[];
  events?: unknown[];
}

export interface ScreenDoc {
  id: string;
  name: string;
  screenType?: string;
  isDefault?: boolean;
  icon?: string;
  layout?: { type: string; cols: number; rows: number };
  widgets: WidgetDoc[];
  edges?: unknown[];
  parentId?: string | null;
  sortOrder?: number;
  backgroundImage?: string | null;
  backgroundOpacity?: number;
}

export interface AlarmRuleDoc {
  id: string;
  tag: string;
  condition: string;
  value: number;
  severity: string;
  message: string;
  deadband?: number;
  delay?: number;
}

export interface PackageMetaDoc {
  schemaVersion: typeof SCADA_PACKAGE_DOC_SCHEMA_VERSION;
  packageName?: string;
  processId?: string | null;
  edgeDeviceId?: string | null;
  automationBindings?: unknown[];
  [key: string]: unknown;
}

export interface ScadaPackageDocV2 {
  meta: PackageMetaDoc;
  screens: ScreenDoc[];
  alarmRules?: AlarmRuleDoc[];
  controlPermissions?: Record<string, unknown>;
  trendConfig?: Record<string, unknown>;
  scripts?: unknown[];
  [key: string]: unknown;
}
