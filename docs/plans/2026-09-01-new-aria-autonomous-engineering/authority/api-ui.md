# GraphQL, Live Channel, Browser ve UI Sözleşmesi

[Authority index](INDEX.md) · Owners: S02, S04, S06-S07, S15, S39, S41, S46, S60.

## Public GraphQL root

Canonical closed SDL, [`graphql/root.graphql`](graphql/root.graphql),
[`graphql/read-model.graphql`](graphql/read-model.graphql) ve
[`graphql/commands.graphql`](graphql/commands.graphql) fragments'larının birleşimidir. ARIA public
root'u tam olarak aşağıdaki yedi query ve dokuz mutation'dır; ek root field forbidden'dır:

```graphql
type Query {
  ariaOverview(workspaceId: ID!, asOf: DateTime): AriaOverviewResult!
  ariaMissions(
    workspaceId: ID!
    first: Int = 25
    after: Cursor
    filter: MissionFilter
    asOf: DateTime
  ): AriaMissionConnectionResult!
  ariaMission(workspaceId: ID!, missionId: ID!, asOf: DateTime): AriaMissionResult!
  ariaTimeline(
    workspaceId: ID!
    missionId: ID
    first: Int = 50
    after: Cursor
    asOf: DateTime
  ): AriaTimelineConnectionResult!
  ariaProviderStatus(workspaceId: ID!, asOf: DateTime): AriaProviderStatusResult!
  ariaPolicyStatus(workspaceId: ID!, asOf: DateTime): AriaPolicyStatusResult!
  ariaProgramProgress(workspaceId: ID!, asOf: DateTime): AriaProgramProgressResult!
}

type Mutation {
  createAriaMissionDraft(input: CreateMissionDraftInput!): AriaCommandResult!
  postAriaConversationMessage(input: PostConversationMessageInput!): AriaCommandResult!
  submitAriaMission(input: SubmitMissionInput!): AriaCommandResult!
  cancelAriaMission(input: CancelMissionInput!): AriaCommandResult!
  retryAriaMission(input: RetryMissionInput!): AriaCommandResult!
  freezeAriaAutonomy(input: FreezeAutonomyInput!): AriaCommandResult!
  resumeAriaAutonomy(input: ResumeAutonomyInput!): AriaCommandResult!
  requestAriaMergeEvaluation(input: MergeEvaluationInput!): AriaCommandResult!
  acknowledgeAriaDecision(input: AcknowledgeDecisionInput!): AriaCommandResult!
}
```

## Closed common types

`first` yalnız `1..100`; default Missions `25`, Timeline `50`. Cursor opaque, signed ve
`workspaceId + query + filterDigest + asOf + authorityVersion + position` bağlıdır; 15 dakika TTL
sonrası typed `STALE` döner. İlk page authoritative `asOf` snapshot'ı üretir; sonraki sayfalar aynı
snapshot'tır. Başka workspace/filter/query/asOf cursor'ı, negative/zero/over-max ve malformed ID
`INVALID`/`DENIED` olur; offset pagination yoktur.

Her section result şunları taşır:

```text
status: OK | EMPTY | MISSING | CORRUPT | UNAVAILABLE
freshness: CURRENT | STALE
asOf, authorityVersion, reasonCode, retryable, data
```

`STALE` projection status yerine freshness boyutudur. Parent roll-up'ta load-bearing child
`CORRUPT|UNAVAILABLE` ise health non-green, prominent ve submit/resume/merge controls disabled'dır.
`EMPTY` yalnız verified empty; GraphQL data+errors, exception, rejected cursor veya missing source
empty render edemez.

Her mutation input closed/unknown-field-reject schema'dır ve ortak olarak `requestId: UUID!`,
`workspaceId: ID!`, `expectedVersion: Long!`, `clientIssuedAt: DateTime!` taşır. Create için
`expectedVersion=0`; diğerleri aggregate current version'ını ister. Request idempotency scope'u
`HumanSubjectId + workspace + operation + requestId`, retention 30 gündür. Same request+payload tek
logical command/result; same request+different payload `INVALID`. Result closed union:

```text
ACCEPTED(commandId, aggregateId, version)
CONFLICT(currentVersion, safeRefreshCursor)
DENIED(reasonCode)
STALE(requiredAuthorityVersion)
INVALID(fieldErrors)
UNAVAILABLE(retryAfter, requestStatusLookupId)
```

Response-loss recovery client-known `requestId` üzerindedir: same `requestId` + same canonical
payload digest, original response commit'ten önce kaybolduysa tek dispatch'i sürdürür; commit'ten
sonra kaybolduysa stored exact result döner ve ikinci command/effect yaratmaz. same `requestId` +
different payload `INVALID` döner. Unknown input/result fields schema validation'da deny olur.
`requestStatusLookupId` yalnız diagnostic correlation metadata'sıdır; recovery authority değildir.

## Operation-specific input ve policy

| Mutation                      | Ek required input / source state                                    | Step-up ve confirmation                                                     |
| ----------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `createAriaMissionDraft`      | repository/workspace snapshot, title; no existing aggregate         | base predicate; no effect                                                   |
| `postAriaConversationMessage` | mission/thread, clientMessageId, text/contextDigest; DRAFT/QUESTION | no direct effect; no step-up                                                |
| `submitAriaMission`           | mission, previewDigest, snapshot/payload/policy digest; DRAFT       | fresh single-use step-up + exact preview confirm                            |
| `cancelAriaMission`           | mission, targetAttemptId, reason; nonterminal                       | dispatch varsa exact preview + step-up; unknown reconcile                   |
| `retryAriaMission`            | mission, failedAttemptId, reason, previewDigest                     | step-up; `UNKNOWN` effect varken deny                                       |
| `freezeAriaAutonomy`          | mandatory reason + scope                                            | emergency always reachable; no step-up dependency; audit + out-of-band kill |
| `resumeAriaAutonomy`          | incident, reconciliationDigest, previewDigest                       | fresh step-up; kill readback/current policy required                        |
| `requestAriaMergeEvaluation`  | mission/PR/base/head/dossier previewDigest                          | fresh step-up; evaluation only, merge effect yok                            |
| `acknowledgeAriaDecision`     | mission/decisionId/reason                                           | base predicate; expected version; no authority escalation                   |

Preview server üretimli canonical payload digest'idir. Payload/workspace/SHA/policy/version değişirse
grant invalid olur. Back button, two tabs, double-click ve timeout at-most-one command üretir.
Freeze step-up service/DB control outage'ında [out-of-band kill](operations-reliability.md) yolunu
gösterir; UI success provider readback olmadan göstermez.

## Conversation ve resumable live result

Message stable `clientMessageId`, server message ID, per-thread monotonic sequence, delivery/ack,
author immutable subject ve context snapshot/digest taşır. Explicit truncation marker/omitted-range
digest olmadan context kısaltılmaz. Resume cursor subject+workspace+thread+sequence+expiry bağlıdır;
duplicate before/after ack tek message olur. Concurrent edit/submit `expectedVersion` conflict'tir;
submit sonrası chat effect üretemez.

Same-origin authenticated SSE endpoint `/api/aria/events` public GraphQL root sayısını değiştirmez.
Envelope:

```text
eventId, workspaceSequence, workspaceId, type, aggregateId, aggregateVersion,
authorityVersion, occurredAt, projectionCursor, payloadDigest
```

Client önce `asOf` snapshot alır, response'taki handoff sequence ile stream açar. `Last-Event-ID`/
resume token subject+workspace+sequence+authority epoch'a bağlıdır; heartbeat 15s, retention horizon
24h, connection max 30m ve bounded buffer vardır. Duplicate suppress, reorder/gap detect edilir;
`ariaTimeline` bounded catch-up exact missing sequence'i doldurur. Horizon expired, replica gap,
overflow veya auth epoch change `RESYNC_REQUIRED`; transport reconnect tek başına completeness
kanıtı değildir. UI gap-free rebuild veya prominent `UNAVAILABLE/RESYNC_REQUIRED` gösterir.

## Browser security

Browser yalnız existing same-origin gateway/reverse proxy üzerinden erişir; direct aria-service
subgraph ingress yoktur. Secure `HttpOnly; SameSite=Strict` session cookie, server-side session,
allowed exact Origin ve credentialed CORS `*` yasağı geçerlidir. GraphQL yalnız POST JSON ve
repository Apollo CSRF-required custom header ile kabul edilir; GET mutation, simple `text/plain`,
`Origin:null`, missing preflight/custom header deny olur.

CSP `connect-src 'self'`, remote integrity/CSP manifest, `Cache-Control: no-store` sensitive API,
logout/revoke/session rotation ve live channel per-event/5m auth-epoch revalidation zorunludur.
Step-up/grant/raw prompt URL, query, local/session storage, log veya resume cursor'a girmez. Stolen
cursor farklı subject/workspace'ta reddedilir.

## Clean-host repository integration gate

S41'den önce S02/S03/S04/S06/S07 authority'si şu matrix'i clean non-repository CWD ve fresh host'ta
kanıtlar:

- service catalog: eight image target/role, `aria` schema/migration owner, env/signals, health ve
  GraphQL subgraph; canonical generator drift-free;
- `ModuleCode.ARIA` SSoT + seed/migration + provision/revoke ve immutable allowlist;
- gateway generated subgraph registry, service mTLS/HMAC, health, rate/complexity, direct-deny;
- full SDL composition/generated client types;
- shell remote declaration/map, protected `/aria` route/nav/deep links, shared federation config;
- nginx dev/prod `/remotes/aria/remoteEntry.js`, CSP/SRI/cache/source-map policy;
- all eight immutable images, compose/deployment/config, empty Postgres/object-store migration,
  readiness; NATS absent boot ve ayrı cert-only-NATS/no-CONNECT-credential boot.

Bir catalog/generated/compose/nginx/shell/gateway kaydı çıkarıldığında gate fail eder. Initial live
scope bu certified repository/host ile sınırlıdır; multi-repository portability S60'ta aynı matrix'i
yeniden kullanır. UI WCAG 2.2 AA, keyboard/focus, non-color states, bounded `aria-live` ve canonical
mission/evidence routes'ını S07/S46 acceptance'ında doğrular.
