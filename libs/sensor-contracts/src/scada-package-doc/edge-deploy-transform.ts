/**
 * @module EdgeDeployTransform
 *
 * Publish-boundary document transform (CONTRACT-H-002), following the
 * upcaster discipline of `./upcast.ts`: pure function, never mutates its
 * input, applied by the cloud IMMEDIATELY BEFORE a SCADA package document
 * ships to a device (after `upcastScadaPackageDoc`, before schema
 * validation / signing / publish).
 *
 * What it does, per {@link classifyWidgetTypeForEdge}:
 *  - collects EVERY reject-class widget (not first-fail) and refuses the
 *    whole document — the caller turns the list into an actionable error;
 *  - strips decorative/display-only widgets out of the edge payload,
 *    reporting each one so the caller can log + surface a summary;
 *  - normalizes the fields the Rust structs require but the open DocV2
 *    save contract does not: screen `name` (defaults to the id),
 *    `screenType` (lowercased into the closed set, default `dashboard`),
 *    alarm `severity` (lowercased, default `warning`), alarm `message`
 *    (defaults to `"<tag> <condition> <value>"`).
 *
 * Rollback deliberately does NOT run this transform: it republishes a
 * SIGNED artifact byte-faithfully, and the edge's `#[serde(other)]
 * Unknown` tolerance absorbs unknown types in pre-transform artifacts.
 */

import {
  EDGE_ALARM_SEVERITIES,
  EDGE_SCREEN_TYPES,
  classifyWidgetTypeForEdge,
  type EdgeAlarmSeverity,
  type EdgeScreenType,
} from './edge-widget-support';
import type {
  AlarmRuleDoc,
  ScadaPackageDocV2,
  ScreenDoc,
  WidgetDoc,
} from './scada-package-doc.types';

/** Identity of a widget the transform removed or refused. */
export interface EdgeDeployWidgetRef {
  screenId: string;
  widgetId: string;
  widgetType: string;
}

export type EdgeDeployTransformResult =
  | { ok: true; doc: ScadaPackageDocV2; stripped: EdgeDeployWidgetRef[] }
  | { ok: false; rejected: EdgeDeployWidgetRef[] };

const SCREEN_TYPE_SET = new Set<string>(EDGE_SCREEN_TYPES);
const SEVERITY_SET = new Set<string>(EDGE_ALARM_SEVERITIES);

function normalizeScreenType(value: unknown): EdgeScreenType {
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (SCREEN_TYPE_SET.has(lowered)) return lowered as EdgeScreenType;
  }
  return 'dashboard';
}

function normalizeSeverity(value: unknown): EdgeAlarmSeverity {
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (SEVERITY_SET.has(lowered)) return lowered as EdgeAlarmSeverity;
  }
  return 'warning';
}

function transformAlarmRule(rule: AlarmRuleDoc): AlarmRuleDoc {
  const message =
    typeof rule.message === 'string' && rule.message.length > 0
      ? rule.message
      : `${rule.tag} ${rule.condition} ${rule.value}`;
  return { ...rule, severity: normalizeSeverity(rule.severity), message };
}

/**
 * Transform a (already-upcasted) V2 document into its edge-deployable
 * form. Pure and idempotent: re-transforming an `ok` result's `doc`
 * yields an equal document with an empty `stripped` list.
 */
export function transformScadaDocForEdgeDeploy(
  doc: ScadaPackageDocV2,
): EdgeDeployTransformResult {
  const rejected: EdgeDeployWidgetRef[] = [];
  const stripped: EdgeDeployWidgetRef[] = [];

  const screens: ScreenDoc[] = (doc.screens ?? []).map((screen) => {
    const kept: WidgetDoc[] = [];
    for (const widget of screen.widgets ?? []) {
      const classification = classifyWidgetTypeForEdge(widget.widgetType);
      if (classification === 'ship') {
        kept.push(widget);
        continue;
      }
      const ref: EdgeDeployWidgetRef = {
        screenId: screen.id,
        widgetId: widget.id,
        widgetType: widget.widgetType,
      };
      if (classification === 'reject') rejected.push(ref);
      else stripped.push(ref);
    }
    return {
      ...screen,
      name: typeof screen.name === 'string' && screen.name.length > 0 ? screen.name : screen.id,
      screenType: normalizeScreenType(screen.screenType),
      widgets: kept,
    };
  });

  // ALL violators are reported in one pass — a deploy must not fail
  // one-widget-at-a-time across repeated attempts.
  if (rejected.length > 0) {
    return { ok: false, rejected };
  }

  const result: ScadaPackageDocV2 = { ...doc, screens };
  if (doc.alarmRules !== undefined) {
    result.alarmRules = doc.alarmRules.map(transformAlarmRule);
  }
  return { ok: true, doc: result, stripped };
}
