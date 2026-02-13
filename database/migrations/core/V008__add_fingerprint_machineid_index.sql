-- V008: Add expression index for fingerprint machineId lookups
-- Used by self-registration duplicate check in provisioning service
CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_edge_devices_tenant_fingerprint_machineid"
ON edge_devices (tenant_id, ((fingerprint->>'machineId')));
