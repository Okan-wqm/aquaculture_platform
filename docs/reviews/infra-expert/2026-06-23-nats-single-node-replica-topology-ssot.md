# Deploy-resilience review — NATS JetStream replica count vs. single-node topology

**Cycle:** 2026-06-23-nats-single-node-replica-topology-ssot
**Owner:** infra-expert
**Class:** ADR-016 (deploy resilience)

## DEPLOY-CRITICAL-008 — single-node NATS cannot recover an R3 stream because replica count was bound to NODE_ENV instead of topology

### Summary

The self-contained DigitalOcean droplet (single local `aqua-nats` container, images
pulled from GHCR) had its entire production stack stuck: `aqua-gateway`,
`aqua-nginx`, `aqua-farm`, and `aqua-notification` sat in `Created` while
`aqua-nats` reported `unhealthy`. This was **not** a broken-image problem — every
service image pulled and most started.

### Root cause

The JetStream stream `AQUACULTURE_EVENTS` was created with `num_replicas: 3` on a
**standalone** NATS server (`infrastructure/docker/nats/nats.conf` declares no
`cluster{}` / `routes` block). A standalone server cannot form a 3-peer Raft
group, so on restart it logs `JetStream stream '$G > AQUACULTURE_EVENTS' could
not be recovered`, `/healthz` returns 503, and because
`docker-compose.droplet.yml` gates dependants on
`depends_on: nats: condition: service_healthy`, the rest of the stack never
leaves `Created`.

The replica count reached 3 because `platform/libs/event-bus/src/nats/nats-event-bus.ts`
derived it from the application environment: `isProductionLike ? 3 : 1`, plus a
hard throw if a production/staging service requested fewer than 3. Replica count
is a property of the **NATS deployment topology** (how many nodes the cluster
has), not of `NODE_ENV`. A single-node production deployment is legitimate, so
binding the two was the defect.

### Why R1 is correct here (durability)

Durability is owned by the **transactional outbox + event-store** (the SSoT):
every event is written to the outbox in the same DB transaction as the domain
change and republished by the outbox worker, so nothing is lost if a JetStream
message is. JetStream replication therefore provides transport HA, not
durability — and `num_replicas: 1` is correct and complete on a single node.

### Evidence

- `platform/libs/event-bus/src/nats/nats-event-bus.ts` — `isProductionLike ? 3 : 1`
  default and the `< 3 in production` throw (constructor); `num_replicas` in
  `getStreamConfig`.
- `infrastructure/docker/nats/nats.conf` — JetStream block with no cluster config
  (standalone).
- `docker-compose.droplet.yml` — `depends_on: nats: condition: service_healthy`
  gating gateway/farm/notification/nginx; the `wget /healthz` healthcheck.
- Live droplet: stream `meta.inf` carried `"num_replicas":3`; NATS logs repeated
  `JetStream stream '$G > AQUACULTURE_EVENTS' could not be recovered`.

### Fix (architectural-solution hierarchy)

1. **Make it impossible (tier 1):** at stream setup, clamp `num_replicas` to what
   the connected server can host. `resolveEffectiveReplicas()` reads the server's
   own `ServerInfo.cluster` (authoritative) and, on a standalone server, forces 1
   with a loud `WARN`. An over-specified replica count can never again create an
   unrecoverable stream.
2. **Make it automatic (tier 2):** desired replica count comes from
   `NATS_STREAM_REPLICAS` (the deployment's topology profile), defaulting to 1
   (always hostable). A clustered deployment opts into higher replication by
   setting it to the node count.
3. Removed the `NODE_ENV`-coupled `must be ≥ 3` throw, which encoded the false
   "production ⇒ clustered" assumption.

### Recovery

Deploy the corrected images, then on the droplet clear the corrupt R3 stream
directory from the `nats_data` volume (zero data loss — the stream store held a
single ~30-byte block and the outbox replays unpublished events) and bring the
stack up; the rebuilt services create an R1 stream the standalone server can
host, `aqua-nats` goes healthy, and the `depends_on`-gated services start.

### Verification

`platform/libs/event-bus/src/nats/__tests__/nats-event-bus.signals.spec.ts`
asserts: R1 accepted in production, default 1 when unset, out-of-range rejected,
standalone clamps to 1 with a warning, and a clustered server keeps the requested
count.
