# D0 adversarial review — API, UI, and operator experience

## Verdict

`CHANGES_REQUIRED`

The D0 design preserves the exact required query and mutation names, the three-conjunct access
predicate, `/aria`, federation name `ariaModule`, and development port `5179`. It also keeps D0
documentation-only and `VERIFYING`, and the reviewed range has no legacy ARIA or workflow diff.
However, the public surface is still an operation-name list rather than an implementable contract,
ARIA-AUDIT-073's required live-result channel is absent, privileged browser transport and action
safety are unspecified, and the plan does not assign the repository integration work needed to
make the remote reachable through the shell and gateway. ARIA-AUDIT-074 and 082 also promise tests
that their owning sprint cards do not fully require. These gaps allow all named sprint exits to pass
while the operator still lacks a safe, linkable, reconnectable interface for running and observing
missions.

## Findings

### APIUI-P1-001 — The “exact GraphQL contract” fixes only operation names, not request/response semantics

- **Evidence:** The complete GraphQL section enumerates seven queries and nine mutations, then
  immediately moves to page names and three read-model metadata terms
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:212-228`). It defines
  no arguments, input/output object types, nullability, union/error codes, pagination direction,
  default/maximum page size, cursor scope, mutation idempotency key, aggregate expected version, or
  conflict result. S06 requires only the seven names plus a schema snapshot
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:65-75`), and S46 similarly
  reduces the complete UI to “seven query/ten mutation allowlist” and generic typed preview—even
  though the fixed list contains nine mutations
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:65-75`). The design's durable
  `idempotency key` and `expected version` apply to externally visible effects, but are not bound to
  the browser mutation contract
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:127-137`).
- **Severity:** P1 API correctness / duplicate and lost-update exposure.
- **Consequence:** The plan does not even have one authoritative mutation cardinality, and
  incompatible schemas can satisfy the name snapshot. An unbounded
  `ariaTimeline`, offset pagination, or cursor not bound to workspace/filter/`asOf` can omit or
  duplicate rows under concurrent writes. Browser retry of draft/message/submit/cancel/retry/
  acknowledge can create duplicate logical commands, and concurrent tabs can overwrite or submit a
  stale draft without a typed conflict that the UI can recover from.
- **Smallest corrective action:** Add a normative compact SDL or per-operation table to the design.
  For every query/mutation, define arguments, closed input/result types, nullability, required
  workspace and aggregate identifiers, stable opaque cursor plus snapshot/`asOf`, page defaults and
  hard maxima, `requestId`/idempotency scope and retention, `expectedVersion`, and typed
  `accepted|conflict|denied|stale|invalid|unavailable` results. Bind S06 and S46 acceptance to the
  exact schema artifact and generated client types, not names alone.
- **Checks:** Snapshot the complete SDL and generated TypeScript types; reject unknown public root
  fields. Exercise zero/negative/over-max page sizes, cursor reuse across workspace/filter/`asOf`,
  writes between pages, duplicate mutation delivery before/after timeout, simultaneous draft
  updates/submits, wrong expected version, malformed IDs, and partial resolver failure. The oracle
  must prove stable pages, exactly one logical command, and a typed recoverable conflict.

### APIUI-P1-002 — ARIA-AUDIT-073 is mapped without any live-result channel or gap-recovery protocol

- **Evidence:** The frozen source says the missing surface includes HTTP/GraphQL/**WebSocket/SSE**
  and explicitly names a live result channel
  (`/var/aqua-saas/.worktrees/aria-full-system-audit-2026-09-01/docs/reviews/2026-09-01-aria-full-system-audit.md:794-800`).
  The new design exposes only query and mutation roots and never chooses a subscription, WebSocket,
  SSE, or bounded polling protocol
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:212-228`). The 073
  matrix row claims `reconnect` testing but its preventive control contains only the query
  allowlist/cursor/UI (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:99`).
  S46 again asks for reconnect tests without delivering a channel, event envelope, resume cursor,
  or catch-up API (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:65-75`).
- **Severity:** P1 product contract / operator observability.
- **Consequence:** A conforming implementation can pass the named tests with a one-time query or
  best-effort push. Disconnects, deploys, tab sleep, and event loss can leave a mission apparently
  stuck or clean; blindly reconnecting can duplicate or skip status, conversation, evidence, and
  decision updates. The user's core requirement to run work and observe live results remains unmet.
- **Smallest corrective action:** Choose one normative live protocol and add it to the public
  contract (for example authenticated SSE with durable monotonic workspace event sequence, event
  type, authority version and heartbeat). Define resume token/`Last-Event-ID`, retention horizon,
  snapshot-then-stream handoff, duplicate suppression, gap detection, bounded catch-up through
  `ariaTimeline`, resync-required behavior, backpressure, terminal close, and fail-visible outage.
  Assign delivery to S06/S07 or S15, not only the late S46 polish sprint, and update row 073's
  control accordingly.
- **Checks:** Disconnect before/after commit, lose/reorder/duplicate an event, reconnect to another
  replica, expire the resume horizon, deploy/restart the server, suspend the tab, revoke access, and
  overflow backpressure. The UI must either reconstruct a gap-free ordered view from the durable
  cursor or prominently enter `resync_required/unavailable`; transport reconnection alone must not
  claim completeness.

### APIUI-P1-003 — Browser/session, CSRF, CORS, and live-channel authentication boundaries are unspecified

- **Evidence:** The browser boundary is labeled only `authenticated GraphQL; typed mutation;
step-up` (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:57-75`).
  The API/web section gives no cookie versus bearer model, CSRF rule, allowed Origin/CORS policy,
  token refresh/logout behavior, session fixation protection, live-connection reauthentication, or
  revocation semantics (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:212-228`).
  Neither S06 nor S07 contains cross-origin/simple-request/credentialed-request/session-expiry
  negatives (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:65-87`). This is
  load-bearing in this repository because `/graphql` is deliberately exempt from the generic
  double-submit middleware and relies on Apollo/request-header behavior
  (`apps/gateway-api/src/middleware/csrf.middleware.ts:22-40`).
- **Severity:** P1 security / privileged browser boundary.
- **Consequence:** The implementation can accidentally expose privileged mutations through a
  direct aria-service origin, misconfigure credentialed CORS, omit the Apollo-required headers, or
  leave a WebSocket/SSE connection authorized after role, allowlist, step-up, or session revocation.
  A secure REST assumption does not automatically secure GraphQL GET/simple requests or long-lived
  streams.
- **Smallest corrective action:** State that browser traffic enters only through the existing
  gateway/same-origin reverse proxy and define the exact session/token transport. Specify allowed
  methods/content types/custom headers, Origin allowlist and credential behavior, GraphQL CSRF
  prevention, CSP `connect-src`, cache-control, refresh/logout/revocation, and live-channel auth plus
  periodic/epoch revalidation. Step-up material must never appear in URL/query, logs, browser
  storage, or resumable channel tokens. Add these to S06/S07/S46 contract tests.
- **Checks:** Cross-site form, `text/plain`, GET mutation, missing requested-with/preflight header,
  attacker Origin with credentials, `Origin: null`, wildcard Origin, expired/rotated session,
  logout while connected, role/module/allowlist removal, stolen resume cursor, and step-up leakage
  tests must all fail closed while permitted same-origin requests continue to work.

### APIUI-P1-004 — The plan names a remote and service but does not assign the host/gateway/module deployment integration

- **Evidence:** PLAN declares `apps/aria-service`, `web/modules/aria`, `/aria`, `ariaModule`, and
  `5179`, but does not enumerate any integration surfaces
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:14-28`). S02 delivers only an inert
  service scaffold; S06 delivers resolver names; S07 delivers the remote values and generic
  federation/route test (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:17-27`,
  `:65-87`). Today `ModuleCode` has no ARIA member
  (`apps/auth-service/src/modules/system-module/entities/module.entity.ts:15-22`), the generated
  gateway registry has no aria subgraph
  (`apps/gateway-api/src/config/federated-subgraphs.generated.ts:15-27`), and the shell remote map has
  no `ariaModule` (`web/shell/vite.config.ts:28-37`). Existing remotes also require shell route/
  navigation, reverse-proxy, compose/image, health, CSP/remote-integrity, and deployment wiring, none
  of which is named by an owning sprint.
- **Severity:** P1 integration correctness / unreachable product surface.
- **Consequence:** S02, S06, and S07 can meet their written exits while the schema is not composed,
  the ARIA module entitlement cannot be represented/provisioned, the shell cannot load the remote,
  or production nginx/compose does not serve it. A localhost `5179` dev server is not the requested
  linkable product interface.
- **Smallest corrective action:** Expand S02/S04/S06/S07 bounded deliverables into an explicit
  integration checklist: service-catalog/schema ownership and generated subgraph registry; gateway
  service identity/HMAC, health and rate/complexity routing; `ModuleCode.ARIA` SSoT, seed/migration
  and immutable-subject workspace allowlist; shell type declaration/remote map/protected route/
  navigation; shared federation config; nginx dev/prod remote path, Docker/compose/image/deploy and
  CSP/SRI manifests. Assign an owner and deterministic test to every generated authority surface.
- **Checks:** Build a production-like environment from clean generated registries, compose the
  supergraph, provision and revoke an ARIA entitlement, open `/aria` and a mission deep link by URL,
  fetch `/remotes/aria/remoteEntry.js`, verify health/readiness and source-map/cache headers, and run
  allow/deny tests through the gateway. A direct subgraph request and an unprovisioned navigation
  path must not bypass the three-conjunct predicate.

### APIUI-P1-005 — Privileged mutation policy and operator confirmation/step-up UX are not operation-specific

- **Evidence:** The base predicate and grant binding are strong but generic
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:95-106`). The API
  section lists nine mutations and says only that submit locks a typed summary and an effective step
  “if necessary” requires policy/step-up
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:217-228`). Freeze,
  resume, retry, merge evaluation and decision acknowledgement have no per-operation required
  authority/step-up matrix, preview payload, confirmation ceremony, or stale-preview rule. S46 asks
  for a typed action preview but no confirmation, focus, challenge, reauthentication, or exact
  preview-digest binding test (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:65-75`).
- **Severity:** P1 operator safety / authorization ambiguity.
- **Consequence:** An implementation can either burden emergency freeze with an unavailable
  ceremony or, more dangerously, let stale/accidental clicks submit, retry, resume autonomy, request
  merge evaluation, or acknowledge a decision without a fresh exact-payload grant. Retry can target
  the wrong failed attempt; resume can reopen unreconciled effects; the screen shown to the operator
  need not be the payload authorized by the backend.
- **Smallest corrective action:** Add a mutation policy matrix with allowed source/mission states,
  role/capability, step-up requirement, reason requirement, confirmation mode, idempotency and
  expected-version behavior. Keep emergency freeze immediately available with explicit audit and
  independent out-of-band kill semantics; require preview→digest→single-use step-up→atomic consume
  for submit/resume/merge-sensitive actions. Define cancel/retry target attempt, outstanding-effect
  reconciliation, disabled/loading/unknown states and safe retry guidance.
- **Checks:** Keyboard double-submit, two tabs, stale preview, changed payload/policy/SHA/workspace,
  expired grant, back-button replay, lost response, wrong attempt, cancel during dispatch, retry
  with an `UNKNOWN` effect, resume before reconciliation, and freeze while step-up service is down.
  Each sensitive action must execute at most once against the exact preview; emergency freeze must
  remain available and visibly auditable.

### APIUI-P1-006 — ARIA-AUDIT-082 loses the required five-state fail-closed projection contract

- **Evidence:** The frozen finding requires every section to return typed
  `ok|empty|missing|corrupt|unavailable`, with `corrupt/unavailable` visible and health non-green
  (`/var/aqua-saas/.worktrees/aria-full-system-audit-2026-09-01/docs/reviews/2026-09-01-aria-full-system-audit.md:895-906`).
  The design says only `stale/corrupt/missing` are separately visible
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:221-228`). The 082 row
  changes that to `missing/invalid/stale`, omitting the authoritative `ok`, verified `empty`, and
  `unavailable` distinction, while promising partial-response tests
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:108`). S06 and S46 do
  not require that closed state union, partial-result aggregation, or non-green health semantics
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:65-75`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:65-75`).
- **Severity:** P1 inherited audit failure / false-clean operator state.
- **Consequence:** A resolver or client can collapse an unavailable subsection, GraphQL partial
  response, rejected cursor, or corrupt projection into empty data while still satisfying the
  prose's “stale/error state” test. Operators can approve/resume based on a dashboard that looks
  clean because a load-bearing source failed.
- **Smallest corrective action:** Preserve the source invariant exactly in the GraphQL type system:
  every section returns a closed `OK|EMPTY|MISSING|CORRUPT|UNAVAILABLE` status plus `asOf`, authority
  version, reason code and retryability; `STALE` is orthogonal freshness, not a replacement status.
  Define parent roll-up and health rules so any load-bearing corrupt/unavailable child is prominent,
  non-green and blocks sensitive actions. Align row 082, S06, S39 and S46.
- **Checks:** Inject corrupt row/object, missing source, dependency timeout, resolver exception,
  GraphQL data-plus-errors partial response, stale/reused cursor, verified empty result, and one bad
  child among healthy sections. Snapshot and accessibility tests must distinguish every state;
  corrupt/unavailable must never render the empty-state copy or enable submit/resume/merge controls.

### APIUI-P2-007 — ARIA-AUDIT-074's conversation proof is broader than its sprint acceptance

- **Evidence:** The source requires durable user session, delivery status, response authorization
  and resume token, and restricts chat to explanation/proposal while effects use typed commands
  (`/var/aqua-saas/.worktrees/aria-full-system-audit-2026-09-01/docs/reviews/2026-09-01-aria-full-system-audit.md:802-809`).
  Row 074 promises restart/disconnect/reorder/**duplicate/context** tests
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:100`). S15 delivers
  messages/questions/answers, delivery/read cursor and draft versioning, but its required tests omit
  duplicate send, context reconstruction/truncation, session/resume-token theft/expiry and
  concurrent draft edit/submit (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P02.md:77-87`).
- **Severity:** P2 conversation durability / matrix-to-card traceability.
- **Consequence:** S15 can pass while a timeout creates duplicate messages, a resumed session loses
  or silently truncates the exact context used for the draft, or a valid thread cursor is replayed
  by the wrong subject/workspace. The finding matrix would then overstate executable prevention.
- **Smallest corrective action:** Add stable message/client-request IDs, per-thread monotonic
  sequence, ack/delivery semantics, context snapshot/digest and explicit truncation disclosure,
  subject/workspace-bound expiring resume cursor, and draft `expectedVersion`/submit barrier to S15.
  Make all row 074 tests literal S15/S46 acceptance items.
- **Checks:** Duplicate before/after ack, lost response, reorder, reconnect on another replica,
  expired/stolen/cross-workspace resume cursor, context window truncation, answer authorization,
  simultaneous edit/submit and message after submit must be deterministic. Chat must never directly
  produce an effect, including via replay.

### APIUI-P2-008 — The information architecture has no canonical deep-link or URL-state contract

- **Evidence:** The design fixes only the remote mount `/aria` and lists page labels such as Mission
  Detail/Conversation and Timeline/Evidence
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:221-224`). S07 likewise
  tests only the base route and remote contract
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:77-87`). No canonical path
  carries mission, attempt, evidence, decision, timeline cursor/filter or selected conversation.
- **Severity:** P2 operator usability / linkability.
- **Consequence:** Operators cannot reliably bookmark, refresh, share, page into, or return from an
  exact mission result/evidence/decision. Local component state can reset to a different workspace
  or newest result after refresh, undermining review and incident handoff even if the data exists.
- **Smallest corrective action:** Define stable nested routes (at minimum mission detail/
  conversation, attempt/result, evidence/decision and program-progress targets), URL-bound safe
  filters/tabs, workspace scoping, invalid/not-found/forbidden behavior, and canonical link creation.
  Opaque secrets, step-up grants and sensitive raw prompts must never enter URLs.
- **Checks:** Direct-load and hard-refresh every canonical route, copy it into a clean authorized
  session, use browser back/forward, switch/revoke workspace, request missing/forbidden IDs, and
  preserve filters across reconnect. The resulting view must identify the same immutable mission/
  attempt/evidence authority without leaking sensitive values.

### APIUI-P2-009 — Accessibility is named as a test but has no acceptance standard for live data or dangerous controls

- **Evidence:** S07 contains the single word `accessibility`
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:77-87`), and S46 says only
  `a11y` tests (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:65-75`). The
  design has no target standard or requirements for landmarks/headings, keyboard navigation, focus
  restoration, dialogs, status/error announcements, live-update rate, reduced motion, contrast,
  non-color status, accessible charts/timelines, or busy/disabled action semantics.
- **Severity:** P2 accessibility / unsafe operator interaction.
- **Consequence:** A generic automated scan can pass while keyboard or screen-reader operators miss
  a corrupt/frozen state, cannot inspect timeline evidence, lose focus after remote/reconnect, or
  accidentally confirm a sensitive action. High-frequency live results can also flood an ARIA live
  region and make the interface unusable.
- **Smallest corrective action:** Make WCAG 2.2 AA the target and add component-level acceptance for
  semantic landmarks/headings, skip/focus management across federated navigation, keyboard-only
  operation, accessible names/descriptions, focus-trapped/restored confirmations, non-color status,
  contrast/reduced motion, table/text alternatives for visual evidence, and throttled summarized
  `aria-live` announcements. Corrupt/unavailable/frozen and mutation results require assertive but
  non-repeating announcements.
- **Checks:** Automated axe plus keyboard-only and representative screen-reader flows for login to
  `/aria`, deep-link mission review, conversation, live reconnect/gap, corrupt/unavailable state,
  submit/cancel/retry/freeze/resume and error recovery. Include zoom/reflow, high contrast, reduced
  motion and live-event burst tests; no critical state or control may be conveyed only by color.

## Verified controls and review checks

- Root `CLAUDE.md`, adversarial brief, full task contract and implementer report, supplied 2,203-line
  diff package, complete design/PLAN/nine phase cards/progress/evidence artifacts, generated
  format-scope diff, all 88 finding rows, and frozen source text for 073/074/082 were inspected.
- The public query names are exactly `ariaOverview`, `ariaMissions`, `ariaMission`, `ariaTimeline`,
  `ariaProviderStatus`, `ariaPolicyStatus`, and `ariaProgramProgress`; the nine required mutation
  names are present with no additional public mutation named in D0.
- The base predicate is correctly stated as
  `SUPER_ADMIN AND ModuleCode.ARIA AND immutable-subject workspace allowlist`; tenant/workspace
  headers are explicitly rejected as identity authority. Step-up binding includes operation,
  workspace, SHA, payload and policy version, and single-use atomic consumption.
- `/aria`, `ariaModule`, and port `5179` match the fixed task decisions. A scan of current
  `web/**/vite.config.*` and module package scripts found no existing `5179` allocation.
- Cancel/retry preserve prior attempts/artifacts, freeze blocks new provider/git/merge intents,
  resume requires reconciliation/current policy, and merged-only work remains `VERIFYING` rather
  than `SOLVED`.
- `git diff --name-only eeb401131..c6065d6da` confirms documentation plus mechanically generated
  `tools/quality/format-scope.json`; the protected legacy ARIA/workflow path query is empty. D0 and
  its evidence admission remain `VERIFYING`/pending.
- Readability is acceptable for D0: design is 292 lines, PLAN 317, phase cards 99 each, and the
  future source rules explicitly prohibit god modules and gate dependency direction, complexity,
  function size, and files above 400 lines.
