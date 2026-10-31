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

| Client ID              | Publisher                                                         | Topic                              |
| ---------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| `nodered-codex-sim-01` | production codex simulator (Node-RED, `/var/lib/aqua/simulators`) | `sensors/codex-test/water-temp-01` |

Moved on 2026-10-31: the repository simulator (`infrastructure/simulators/nodered`, client ID
`nodered-simulator`, three `sensors/farm-01/...` streams). Its broker authenticated from a
password file, so no issued principal could connect to it. The simulator stack now runs the
platform broker image with its production config. Each of the three sensors publishes on its
own issued principal, read from the environment. The simulator's equipment and edge tabs,
which also connected as `sensor_service`, are removed (ADR-047 implementation notes).
`tests/invariants/repository-sensor-simulator.spec.ts` keeps the flows on their own principals,
and `repository-simulator.mosquitto.spec.ts` proves them on the real broker.

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
