/**
 * An edge device's command topic, in both shapes the agent subscribes to:
 * `tenants/{tenant}/devices/{device}/commands[/…]` and the legacy
 * `edge/{device}/commands[/…]` (ADR-048 DEC-9.2). The broker ACL
 * (MqttAuthService: only sensor_service may write one) and the MQTT client
 * (only `publishDeviceCommand` writes one, and only to one) read the same
 * pattern, so the two cannot disagree about what a command topic is.
 */
export const DEVICE_COMMAND_TOPIC =
  /^(?:tenants\/[^/]+\/devices\/[^/]+|edge\/[^/]+)\/commands(?:\/|$)/;

export function isDeviceCommandTopic(topic: string): boolean {
  return DEVICE_COMMAND_TOPIC.test(topic);
}
