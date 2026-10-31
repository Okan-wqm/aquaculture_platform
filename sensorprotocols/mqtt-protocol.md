# MQTT — a sensor publishing to the platform broker

The device contract of a sensor that speaks MQTT itself. Governing decision:
[ADR-047](../docs/adr/047-per-sensor-mqtt-identity.md). A sensor behind an edge gateway does not
use this contract: the gateway is the broker principal. A customer-operated broker is not
supported; it needs an ADR of its own.

This file replaces an earlier design of a user-configured MQTT client form (broker URL, typed
credentials, retained readings, a Last Will, a `sensors/{location}` topic tree). None of that
applies: the platform issues the connection, and the broker refuses anything else.

## Connection

Issued when the sensor (or its parent device) is registered, and again each time its credential
is reissued from the device page. The password is shown once and is not stored.

| Setting            | Value                                             |
| ------------------ | ------------------------------------------------- |
| Host               | as issued (the platform's public name)            |
| Port               | 8883, TLS 1.2 or later, public CA roots           |
| Protocol           | MQTT 3.1.1 or 5                                   |
| Client ID          | the issued username: `s` and 22 base32 characters |
| Username, password | as issued                                         |
| Keepalive          | at most 300 seconds                               |
| QoS                | 1                                                 |
| Retain             | off (a retained message is dropped)               |
| Last Will          | none                                              |

The broker refuses a CONNECT under any other client ID, and a CONNECT without one.

## Topic

`tenants/{tenantId}/sensors/{sensorId}/data`, issued with the connection. The credential may
publish there and nowhere else: no subscribe, no other topic. No service account can write to
it, so a message there comes from the sensor.

## Message

One JSON object per message, at most 16 KiB, nested at most three levels below the top, at most
64 keys or items per level, strings at most 256 characters.

- Each of the sensor's data channels reads the value its data path names (`ph`,
  `sensors.mid`, `values[0]`); with no data path, its channel key. The value must be a JSON
  number. A numeric string (`"7.1"`) is refused.
- An optional `timestamp`, RFC 3339 with an offset (`2026-10-30T20:15:00Z`), is the sample time
  when it lies between an hour before and a minute after the message arrives. In any other
  form, or outside that window, it is ignored and the arrival time is used.
- Other keys are ignored.

```json
{ "timestamp": "2026-10-30T20:15:00Z", "ph": 7.1, "temperature": 18.4 }
```

At most one message a second per sensor is accepted, with a burst of ten; the broker refuses
a PUBLISH over that rate (`sensor_principal_publishes_rate_limited_total`).

## Activation

The platform does not dial the sensor and runs no connection test. The sensor stays DRAFT until
its first message stores a reading; it then becomes ACTIVE, with its child sensors, and stays
ACTIVE while data arrives.

## Credential lifecycle

- Reissuing the credential stops the old one at its next publish.
- Suspending the sensor withdraws its credential. Reactivating it returns it to DRAFT with no
  credential; a new one is issued from the device page, and its data activates the sensor again.
- Deleting the sensor removes its credential.

## Dropped, and counted

Nothing is stored, and `sensor_principal_messages_dropped_total` counts the reason, for: a
retained message, a message over the size limit, one that is not JSON or not of the shape above,
one for a sensor that no longer holds its credential or is suspended, one for a tenant no longer
active, and one in which no channel finds a number.

## Legacy topics

Sensors registered before ADR-047 may still publish on `sensors/#`, `aquaculture/+/sensors/#`
and `+/+/+/temperature-array` with the service account, until each moves to its own credential
(SENSOR-HIGH-207, `docs/reviews/claude/2026-10-30-sensor-mqtt-legacy-publishers.md`). A new
registration cannot use them.
