# The gateway gave up composing and served without `auth` for hours

Date: 2026-09-18
Reviewer: claude
Scope: `apps/gateway-api/src/config/**`

## How this surfaced

At 18:46:24Z a deploy (image tag `fazai-2`) restarted `aqua-gateway`; `aqua-auth` came
back at 18:49:51Z, three and a half minutes later. `RetryableIntrospectAndCompose`
spent its 24 attempts (~72 s) on `Couldn't load service definitions for "auth" at
http://auth-service:3000/graphql: … ECONNREFUSED 172.20.0.21:3000`, then:

```text
All 24 composition attempts exhausted (total budget: ~72s). Gateway startup will fail;
Docker will restart the container.
Background supergraph composition failed terminally: … Gateway stays not_ready
(/health/ready) but /health/live remains up.
```

Nothing restarted anything: ARCH-GW-006 made composition non-blocking so the listener
binds and `/health/live` answers 200 before the real schema lands, and the container's
health check reads liveness. The gateway served with the placeholder supergraph —
`/health/ready` 503, no `auth` subgraph — and every `login` mutation answered
**"Unknown type LoginInput"** for the next half hour, until a human ran
`docker restart aqua-gateway` (19:19Z; ready 200 thirty seconds later, `Supergraph
composition succeeded; gateway is now ready.`).

## Finding — INFRA-HIGH-175

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-10-02
- **Layer:** 2 (production control plane)
- **Rule:** the order in which containers come back is not a property a process may
  assume; a dependency that is merely late is composed when it arrives, and the only
  human act a late subgraph may require is none.
- **Evidence:** `apps/gateway-api/src/config/background-composition.manager.ts`
  (`composeInBackground`: one round, then `markCompositionError` and return),
  `apps/gateway-api/src/config/retryable-introspect.ts` (the "Docker will restart the
  container" line, untrue since ARCH-GW-006), gateway logs 18:46–18:48Z and 19:19Z above.
- **What is now true:** `BackgroundCompositionManager` runs composition in rounds without
  end. A round is the composer's own bounded budget; when it exhausts, the manager records
  the reason on the readiness state (503 with that reason, exactly as before), waits — 5 s
  doubling to a 60 s cap — and starts the next round, until the real supergraph is
  hot-swapped in and readiness latches. Liveness is unchanged. The stale log line names
  what actually happens next. Pinned in `background-composition.manager.spec.ts`: a
  subgraph that arrives on the third round is composed with the back-off sequence
  `[5 s, 10 s]`; a subgraph that never arrives keeps the last reason on readiness, caps the
  back-off at 60 s and never stops; an exhausted round still neither throws nor composes.
- **Not done here (named):** the deploy's restart ordering itself (`depends_on:
condition: service_healthy` for the gateway, or a rolling restart that brings subgraphs
  up first) — a belt to this fix's braces, in the deploy owner's lane; and the health
  check reading readiness for a gateway that has been unready longer than N minutes, which
  would restart a wedged process this fix cannot un-wedge (a composition error that is not
  a late subgraph).
