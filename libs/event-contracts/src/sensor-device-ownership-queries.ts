/**
 * The edge-device ownership question gateway-api asks sensor-service before it lets a socket
 * stream a device's I/O (`request.sensor.verifyDeviceOwnership`, the subject constant
 * `NATS_PATTERNS.SENSOR.VERIFY_DEVICE_OWNERSHIP` in backend-common; SEC-M18, SEC-CRITICAL-207).
 *
 * The answer names the device's site, so the /sensors gateway admits a site-bound sensor operator
 * to the devices of its own sites only (ADR-051 §1: a site assignment restricts every module where
 * the user is MODULE_USER). sensor-service builds its reply with `verifyDeviceOwnershipReply`;
 * gateway-api reads it with `devicePlacementOf`, which reads a reply without `siteId` (from a
 * responder of the release before the field) as a device on no site, so a site-bound caller is
 * refused rather than admitted while the two services roll.
 */
export interface VerifyDeviceOwnershipRequest {
  readonly deviceCode: string;
  readonly tenantId: string;
}

export type VerifyDeviceOwnershipResponse =
  | { readonly owned: false; readonly siteId: null }
  | { readonly owned: true; readonly siteId: string | null };

/** Where an owned device stands: its site, or null for a device placed on no site. */
export interface DevicePlacement {
  readonly siteId: string | null;
}

/** sensor-service's reply for the device it found in the tenant (null: none). */
export function verifyDeviceOwnershipReply(
  device: DevicePlacement | null,
): VerifyDeviceOwnershipResponse {
  return device === null ? { owned: false, siteId: null } : { owned: true, siteId: device.siteId };
}

/** The placement of an owned device, or null when the reply owns nothing or is malformed. */
export function devicePlacementOf(reply: unknown): DevicePlacement | null {
  if (typeof reply !== 'object' || reply === null) return null;
  if (!('owned' in reply) || reply.owned !== true) return null;
  if (!('siteId' in reply) || reply.siteId === null) return { siteId: null };
  return typeof reply.siteId === 'string' && reply.siteId.length > 0
    ? { siteId: reply.siteId }
    : null;
}
