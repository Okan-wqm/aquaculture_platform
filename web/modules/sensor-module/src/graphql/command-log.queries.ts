/**
 * Command log documents (/sensor/commands).
 *
 * WHY: sensor-service has recorded every VFD runtime command (who, what,
 * value, result, latency, origin) in the append-only `vfd_command_audit_logs`
 * ledger since DB-SENSOR-HIGH-003, but no web document read it — the drive
 * panel kept only an in-memory history of the commands sent from that tab.
 *
 * WHAT: `vfdCommandAuditLog(vfdDeviceId, limit)` — one drive's trail, newest
 * first (apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts,
 * TENANT_ADMIN / MODULE_MANAGER). The feeding-send and deployment reads the
 * page also shows reuse their existing documents (plc.operations.ts,
 * automation.queries.ts).
 */

export const VFD_COMMAND_AUDIT_LOG_QUERY = `
  query VfdCommandAuditLog($vfdDeviceId: ID!, $limit: Int) {
    vfdCommandAuditLog(vfdDeviceId: $vfdDeviceId, limit: $limit) {
      id
      vfdDeviceId
      command
      value
      success
      error
      performedBy
      performedByEmail
      source
      latencyMs
      timestamp
    }
  }
`;
