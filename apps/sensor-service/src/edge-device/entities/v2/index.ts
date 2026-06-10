/**
 * Edge Platform v2 entity barrel.
 *
 * 7 per-tenant entities under sensor schema, per ADR-034.
 *
 * These supersede ADR-022's `edge.*` placement. v1 entities
 * (edge-device.entity.ts et al.) remain alongside in
 * apps/sensor-service/src/edge-device/entities/ during the dual-write
 * cutover window (Faz 6 of the day-one baseline reset is the cutover
 * point; pre-Faz-6, the v2 tables are baseline-only and read by
 * Open Host Service consumers).
 */
export { EdgeDeviceV2 } from './device-v2.entity';
export { EdgePolicyV2 } from './policy-v2.entity';
export { EdgeLicenseV2 } from './license-v2.entity';
export { EdgeFirmwareReleaseV2 } from './firmware-release-v2.entity';
export { EdgeProvisioningRecordV2 } from './provisioning-record-v2.entity';
export { EdgeWitnessV2 } from './witness-v2.entity';
export { EdgeAuditArchiveV2 } from './audit-archive-v2.entity';
