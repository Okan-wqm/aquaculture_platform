/**
 * Single source of truth for how "real" each registered protocol adapter is.
 *
 * The sensor-service ships 39 protocol adapters, but only a subset perform
 * genuine device I/O. Historically every adapter was surfaced identically to
 * the registration wizard and a stub adapter's unconditional
 * `testConnection() => { success: true }` was enough to flip a sensor to
 * ACTIVE — a never-contacted device presented as connected
 * (SENSOR-CRITICAL-008).
 *
 * This module classifies every adapter by WHERE its real I/O lives. The
 * classification is consumed by:
 *   - ProtocolRegistryService.getAllProtocols() — UNSUPPORTED protocols are
 *     never returned, so they cannot be selected in the wizard at all.
 *   - ConnectionTesterService.testConnection() — only CLOUD_REAL protocols run
 *     their adapter's live test; anything else returns an honest failure
 *     instead of a stub's fake success, so ACTIVE can only be reached by a
 *     real connection attempt.
 *
 * Completeness is enforced by
 * `protocol-implementation-status.spec.ts`: every code registered in
 * PROTOCOL_ADAPTERS must be classified here. An unclassified code fails SAFE
 * to UNSUPPORTED (hidden + untestable), never to a selectable default.
 */
export enum ProtocolImplementationStatus {
  /** Real cloud-side I/O: the adapter opens a socket/connection and honestly
   *  succeeds or fails against the device. */
  CLOUD_REAL = 'cloud-real',
  /** Real protocol whose device I/O runs on the edge gateway. The cloud cannot
   *  verify it directly; a live check must be delegated to the edge. */
  EDGE_DELEGATED = 'edge-delegated',
  /** No production implementation on either the cloud or the edge. Must never
   *  be selectable and must never report a successful connection. */
  UNSUPPORTED = 'unsupported',
}

const S = ProtocolImplementationStatus;

/**
 * Classification keyed by adapter `protocolCode`. Keep in lockstep with
 * PROTOCOL_ADAPTERS — the invariant spec fails the build if a registered code
 * is missing here.
 */
export const PROTOCOL_IMPLEMENTATION_STATUS: Readonly<
  Record<string, ProtocolImplementationStatus>
> = {
  // Cloud-real: the adapter performs a real connection attempt (honest
  // success/failure), so gating ACTIVE on its result is truthful.
  MODBUS_TCP: S.CLOUD_REAL,
  MODBUS_RTU: S.CLOUD_REAL,
  MODBUS_ASCII: S.CLOUD_REAL,
  OPC_UA: S.CLOUD_REAL,
  SIEMENS_S7: S.CLOUD_REAL,
  MQTT: S.CLOUD_REAL,
  AMQP: S.CLOUD_REAL,
  COAP: S.CLOUD_REAL,
  HTTP_REST: S.CLOUD_REAL,
  WEBSOCKET: S.CLOUD_REAL,
  TCP_SOCKET: S.CLOUD_REAL,
  UDP_SOCKET: S.CLOUD_REAL,

  // Edge-delegated: a genuine protocol whose bus/radio only exists on the edge
  // gateway (Raspberry Pi I2C/SPI, LoRaWAN concentrator). Selectable, but the
  // cloud cannot connect — a live test must go through the edge.
  I2C: S.EDGE_DELEGATED,
  SPI: S.EDGE_DELEGATED,
  LORAWAN: S.EDGE_DELEGATED,

  // Unsupported: no production I/O on the cloud or the edge. These adapters
  // were stubs whose testConnection faked success. Hidden from selection.
  AB_DF1: S.UNSUPPORTED,
  AB_ETHERNET: S.UNSUPPORTED,
  BACNET_IP: S.UNSUPPORTED,
  BACNET_MSTP: S.UNSUPPORTED,
  BLE: S.UNSUPPORTED,
  CANOPEN: S.UNSUPPORTED,
  CCLINK: S.UNSUPPORTED,
  DDS: S.UNSUPPORTED,
  DEVICENET: S.UNSUPPORTED,
  ESP_NOW: S.UNSUPPORTED,
  ETHERCAT: S.UNSUPPORTED,
  ETHERNET_IP: S.UNSUPPORTED,
  KNX_IP: S.UNSUPPORTED,
  MITSUBISHI_MC: S.UNSUPPORTED,
  OMRON_FINS: S.UNSUPPORTED,
  ONE_WIRE: S.UNSUPPORTED,
  PROFIBUS_DP: S.UNSUPPORTED,
  PROFINET: S.UNSUPPORTED,
  RS232: S.UNSUPPORTED,
  RS485: S.UNSUPPORTED,
  SCHNEIDER_MODICON: S.UNSUPPORTED,
  THREAD_MATTER: S.UNSUPPORTED,
  ZIGBEE: S.UNSUPPORTED,
  ZWAVE: S.UNSUPPORTED,
};

/**
 * Resolve a protocol's implementation status. Fails SAFE: an unclassified code
 * is treated as UNSUPPORTED (never selectable, never testable) rather than
 * defaulting into a selectable/real bucket.
 */
export function getProtocolImplementationStatus(code: string): ProtocolImplementationStatus {
  return PROTOCOL_IMPLEMENTATION_STATUS[code] ?? ProtocolImplementationStatus.UNSUPPORTED;
}

/** True when a protocol may be offered for selection in the registration UI. */
export function isSelectableProtocol(code: string): boolean {
  return getProtocolImplementationStatus(code) !== ProtocolImplementationStatus.UNSUPPORTED;
}
