# Plain-MQTT publishers on the service account — 2026-10-30

The legacy-publisher list ADR-047 §7 asks for, registered with the broker's client-ID
bindings (SENSOR-CRITICAL-173).

## SENSOR-HIGH-207

Defect. Publishers of plain sensors still connect to the platform broker with the
`sensor_service` account and publish on free-text topics. That account reads and writes
every tenant's sensor, device, alert and command topics, so a leaked simulator
credential is the platform's ingestion credential.

Severity HIGH. Owner Okan-wqm, deadline 2026-11-13.

The list, as of 2026-10-30:

| Client ID              | Publisher                                                         | Topic                               |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| `nodered-codex-sim-01` | production codex simulator (Node-RED, `/var/lib/aqua/simulators`) | `sensors/codex-test/water-temp-01`  |
| `nodered-simulator`    | repository simulator (`infrastructure/simulators/nodered`)        | three `sensors/farm-01/...` streams |

Until a publisher moves, its client ID stays reserved to `sensor_service`
(`LEGACY_SENSOR_SERVICE_PUBLISHERS`), so the broker binding admits it and no other principal
can take it.

Moving a publisher:

1. Issue the sensor its own principal (`rotateSensorMqttCredentials`, or the device page).
   Its legacy topic stops reaching it at once.
2. Point the publisher at the issued host, port, client ID, username, password and topic.
3. Remove its row above and its client ID from `LEGACY_SENSOR_SERVICE_PUBLISHERS`.

When the list is empty, the legacy filters leave the listener's subscription set, the
legacy publish grants leave `sensor_service`, and the listener's readiness moves to the
sensor data filter (ADR-047 §7). That change closes this finding.
