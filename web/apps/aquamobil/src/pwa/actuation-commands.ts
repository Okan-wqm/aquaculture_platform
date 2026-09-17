/**
 * The mutations that must NEVER enter the offline queue.
 *
 * WHY THIS FILE EXISTS. Every other write this app queues DESCRIBES something
 * that already happened: a mortality count logged on a boat with no signal is a
 * fact about a fish that is already dead, so replaying it two hours later
 * records the same fact. A drive command is the opposite — it does not describe
 * the world, it CHANGES it, and it changes it at the moment of DELIVERY. A
 * `startVfd` that drains from the queue after the worker has stowed the phone
 * and sailed home spins an auger nobody is standing next to, into a pen nobody
 * is watching, for as long as nobody notices.
 *
 * The server already holds this line from its own side: `assertActuable`
 * (apps/sensor-service/src/vfd/services/vfd-drive-binding.service.ts) refuses a
 * drive whose equipment attestation has aged past ATTESTATION_MAX_AGE_MS,
 * precisely because acting on stale truth about an actuator is the hazard. A
 * client-side queue that replays a command hours later is the same hazard
 * arriving from the other direction, so this client refuses it structurally
 * rather than by remembering not to.
 *
 * WHAT IT IS. The GraphQL root fields of every drive-actuation mutation the
 * sensor subgraph exposes (see vfd-command.resolver.ts). Two gates consume it:
 *
 *   Tier 1 — src/pwa/operation-registry.ts declares
 *     `QueueExcludesActuationCommands`, which is a constraint violation the
 *     moment `OperationType` and this list intersect. Adding `'startVfd'` to the
 *     queue's op union fails the BUILD, on a line whose name says why.
 *   Tier 3 — src/pwa/__tests__/vfd-command-never-queued.spec.ts scans the
 *     registry's documents and the op union for these names, which also catches
 *     a command document smuggled in under an innocent-looking op name.
 *
 * ZERO IMPORTS, deliberately, exactly like operation-registry.ts: that file
 * bundles into the service-worker sub-build (tsconfig.sw.json — ES2020 +
 * WebWorker, no DOM, no React) and reaches this list through `import type`, so
 * nothing here may drag a runtime dependency into that graph.
 */

/**
 * Root fields of the sensor subgraph's drive-actuation mutations.
 *
 * `emergencyStopVfd` is on the list even though the server lets EVERY
 * authenticated user call it: an emergency stop is worth less than nothing if it
 * arrives late, so queueing one would be the most dangerous entry of all.
 */
export const ACTUATION_COMMAND_ROOT_FIELDS = [
  'sendVfdCommand',
  'startVfd',
  'stopVfd',
  'setVfdFrequency',
  'setVfdSpeed',
  'resetVfdFault',
  'emergencyStopVfd',
] as const;

/** One of the actuation root fields above, as a type. */
export type ActuationCommandRootField = (typeof ACTUATION_COMMAND_ROOT_FIELDS)[number];
