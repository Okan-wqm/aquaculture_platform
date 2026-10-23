/**
 * An edge device's result topic, `tenants/{tenant}/devices/{device}/results[/…]`
 * (ADR-048 DEC-27; contract channels.json `mqtt.topics.results`): the one
 * topic on which a Suderra OS agent republishes the `suderra.result.v1`
 * documents root wrote. The broker ACL (MqttAuthService: only the device
 * writes it, and the device writes nothing else of this kind) and the
 * listener's subscription set read the same pattern, so the two cannot
 * disagree about what a result topic is.
 */
export const DEVICE_RESULTS_TOPIC = /^tenants\/[^/]+\/devices\/[^/]+\/results(?:\/|$)/;

export function isDeviceResultsTopic(topic: string): boolean {
  return DEVICE_RESULTS_TOPIC.test(topic);
}
