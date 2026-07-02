/**
 * @platform/sensor-contracts — canonical sensor-domain contracts shared
 * between sensor-service (NestJS), sensor-module (React MFE), and — via
 * the JSON Schemas under `schemas/` — the Rust edge agent.
 *
 * Faz 1 scope: the branded TagRef identity (Tag SSoT foundation).
 * Later phases add the ScadaPackageDoc schema/upcasters and the
 * deploy-payload schemas (contract-parity with sens-api-gateway).
 */

export {
  TagRef,
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

export { TAG_REF_SCHEMA, validateTagRef } from './schemas/tag-ref.schema';
