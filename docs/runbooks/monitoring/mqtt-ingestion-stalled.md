# MqttIngestionStalled

The sensor-service MQTT listener has received no broker messages for 10
minutes while the broker connection itself reports healthy and at least one
filter is subscribed. This is the "green but dead" state the
SENSOR-MEDIUM-123 fixes target: before them, a listener whose SUBSCRIBE
batch was denied (SUBACK 0x80) stayed connected, healthy, and silent while
every MQTT sensor in every tenant stopped ingesting.

## What the alert means

- `increase(sensor_mqtt_messages_received_total[10m]) == 0` — the broker
  delivered nothing (or the listener is subscribed to nothing that receives).
- `sensor_mqtt_connected == 1` — the TCP/MQTT session is up, so this is NOT a
  connection outage.
- `sensor_mqtt_subscriptions_granted > 0` — at least one filter is
  broker-acknowledged.

## Triage

1. **Denied filters?** `sensor_mqtt_subscriptions_denied > 0` means the
   broker rejected some filters at (re)subscribe. Check:
   `docker logs aqua-sensor 2>&1 | grep 'DENIED by broker'` — each denied
   filter is listed. The grant list derives from
   `SENSOR_SERVICE_SUBSCRIPTION_FILTERS`
   (apps/sensor-service/src/ingestion/mqtt-listener.service.ts); the ACL
   grants live in mqtt-auth.service.ts and the parameterized spec keeps them
   in sync. A new filter without a matching ACL grant is the classic cause.
2. **Subscription state after a restart:**
   `docker logs aqua-sensor 2>&1 | grep 'MQTT boot signal: subscribed to'` —
   the deploy gate also requires this line (required-signals.yaml). Missing
   on a RUNNING container means the subscribe never completed.
3. **Broker side:** `docker logs aqua-mosquitto 2>&1 | grep -i sensor_service`
   should show the client's SUBSCRIBE entries; 403s here mean go-auth →
   sensor-service /mqtt/acl denials (check MQTT_SENSOR_SERVICE_HASH matches
   MQTT_SENSOR_SERVICE_PASSWORD in the deploy .env).
4. **Is anything publishing?** Confirm a known publisher (e.g. the Node-RED
   simulator on the test droplet) is alive; on quiet installations this alert
   needs a synthetic canary publish (see the post-deploy runbook).

## Recovery

- Re-run subscriptions: restarting aqua-sensor re-subscribes per-filter; with
  the per-topic SUBSCRIBE isolation one bad filter no longer kills the rest.
- ACL drift: fix the grant (or the filter list), redeploy sensor-service; the
  MQTT_ACL_E2E=1 spec reproduces SUBACK behavior against a real broker.

## Related

- Boot gate: `mqtt_subscribed_topics` in infrastructure/deploy/required-signals.yaml
- E2E: apps/sensor-service/src/edge-device/**tests**/mqtt-acl.mosquitto.spec.ts
