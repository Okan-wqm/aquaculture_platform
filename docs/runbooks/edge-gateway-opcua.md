# Edge Gateway OPC UA RC2 Runbook

Audience: integrator connecting RC2 to Siemens, Beckhoff, B&R, or Unified Automation OPC UA endpoints.

## RC2 Boundary

- The always-compiled OPC UA path is the client in `sens-api-gateway/src/plc_programming/opcua.rs`.
- The optional OPC UA server is behind the `opc-ua-server` feature and is not part of the RC2 release profile.
- RC2 release tier is `scada-display`; it does not include `opc-ua-server`.
- Treat the client as `SecurityPolicy#None` and `SecurityMode#None` unless a later runtime PR proves signed/encrypted chunk support.

## Network Controls

Use at least one of these compensating controls before enabling OPC UA client traffic:

- Physically isolated OT cell network.
- Site VPN or WireGuard/IPsec overlay.
- Firewall allowlist from edge device to known PLC endpoint only.
- No internet-routable PLC endpoint.

## Configuration Review

Before deployment, record:

- PLC endpoint URL and IP address.
- Namespace ids used by read/write paths.
- Whether username/password is required.
- Whether the PLC has unsecured OPC UA endpoint enabled by exception.
- Written approval for the compensating network control.

## Pre-Flight Checks

```bash
systemctl is-active suderra-agent
journalctl -u suderra-agent --since "10 min ago" -p warning --no-pager
nc -vz <plc-ip> 4840
```

Do not continue if the device is unstable or the PLC endpoint is not reachable from the approved network path.

## Failure Behavior

- Oversized OPC UA responses must be rejected by the client size limit.
- Read/write operation status codes must surface as errors when not `Good`.
- If a secured-only PLC refuses `SecurityPolicy#None`, do not downgrade plant security globally; keep the PLC secured and defer integration until the runtime security-policy PR lands.

## Evidence to Store

- Approved network exception.
- Endpoint URL and namespace mapping.
- Journal excerpt for first successful connection.
- Read-only test result.
- Write test result only when an approved non-life-support test tag exists.

## Cross-References
