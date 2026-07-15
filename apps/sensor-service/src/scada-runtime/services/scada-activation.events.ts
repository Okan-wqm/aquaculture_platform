/**
 * SCADA activation-bridge event contract (RT-011 Faz 3).
 *
 * The runtime engines (`AlarmEngineService`) depend on the gateway, and the
 * gateway/`ScadaPackageService` must NOT import the engine (circular). So the
 * activation lifecycle crosses those boundaries as EventEmitter2 events — the
 * same neutral-constants pattern as `alarm-ack.events.ts`. `ScadaActivationService`
 * is the single `@OnEvent` consumer; producers import only these constants.
 *
 * In-process EventEmitter2 (not NATS) is sufficient: sensor-service is
 * single-replica (ADR-045 D5), so a publish/subscribe signal never needs to
 * cross a process boundary.
 */

/** Fired by the gateway when a tenant gains its FIRST connected operator socket (0→1). */
export const SCADA_TENANT_OPERATOR_CONNECTED = 'scada.tenant.operator_connected';

/** Fired by the gateway when a tenant loses its LAST connected operator socket (→0). */
export const SCADA_TENANT_OPERATOR_DISCONNECTED = 'scada.tenant.operator_disconnected';

/** Fired by ScadaPackageService when a package transitions to PUBLISHED. */
export const SCADA_PACKAGE_PUBLISHED = 'scada.package.published';

/** Fired by ScadaPackageService when a package transitions to ARCHIVED. */
export const SCADA_PACKAGE_ARCHIVED = 'scada.package.archived';

export interface ScadaTenantOperatorEvent {
  tenantId: string;
}

export interface ScadaPackageLifecycleEvent {
  tenantId: string;
  packageId: string;
}
