/**
 * @platform/sensor-contracts — canonical sensor-domain contracts shared
 * between sensor-service (NestJS), sensor-module (React MFE), and — via
 * the JSON Schemas — the Rust edge agent.
 *
 * This barrel is browser-safe: pure types, the branded TagRef grammar,
 * plain JSON Schema objects, and the document upcasters. Compiled AJV
 * validators are backend-only and live in
 * `@platform/sensor-contracts/validators`.
 */

export {
  TagRefParseError,
  TAG_REF_PATTERN,
  TAG_REF_DEVICE_CODE_PATTERN,
  TAG_REF_LOCAL_NAME_PATTERN,
  isTagRef,
  parseTagRef,
  buildTagRef,
  tagRefFromUnifiedTag,
  splitTagRef,
} from './tag-ref';
export type { TagRef } from './tag-ref';

export { TAG_REF_SCHEMA } from './schemas/tag-ref.schema';
export { COMMAND_ENVELOPE_SCHEMA, UUID_PATTERN } from './schemas/command-envelope.schema';
export { DEPLOY_PROCESS_PARAMS_SCHEMA } from './schemas/deploy-process.schema';
export { DEPLOY_PROGRAM_PARAMS_SCHEMA } from './schemas/deploy-program.schema';
export { DEPLOY_SCADA_PACKAGE_PARAMS_SCHEMA } from './schemas/deploy-scada-package.schema';
export {
  BUNDLE_MANIFEST_SCHEMA,
  DEPLOY_BUNDLE_PARAMS_SCHEMA,
  ED25519_SIGNATURE_HEX_PATTERN,
  SHA256_HEX_PATTERN,
} from './schemas/deploy-bundle.schema';

export { SCADA_PACKAGE_DOC_SCHEMA_VERSION } from './scada-package-doc/scada-package-doc.types';
export type {
  WidgetPositionDoc,
  WidgetDoc,
  ScreenDoc,
  AlarmRuleDoc,
  PackageMetaDoc,
  ScadaPackageDocV2,
} from './scada-package-doc/scada-package-doc.types';

export { SCADA_PACKAGE_DOC_V2_SCHEMA } from './scada-package-doc/scada-package-doc.schema';

export {
  EDGE_SUPPORTED_WIDGET_TYPES,
  EDGE_REJECTED_WIDGET_TYPES,
  EDGE_SCREEN_TYPES,
  EDGE_ALARM_SEVERITIES,
  classifyWidgetTypeForEdge,
} from './scada-package-doc/edge-widget-support';
export type {
  EdgeSupportedWidgetType,
  EdgeRejectedWidgetType,
  EdgeScreenType,
  EdgeAlarmSeverity,
  EdgeWidgetClassification,
} from './scada-package-doc/edge-widget-support';

export { EDGE_SCADA_PACKAGE_DOC_SCHEMA } from './scada-package-doc/edge-scada-package-doc.schema';

export { transformScadaDocForEdgeDeploy } from './scada-package-doc/edge-deploy-transform';
export type {
  EdgeDeployWidgetRef,
  EdgeDeployTransformResult,
} from './scada-package-doc/edge-deploy-transform';

export { upcastScadaPackageDoc } from './scada-package-doc/upcast';
export type { UpcastContext } from './scada-package-doc/upcast';
