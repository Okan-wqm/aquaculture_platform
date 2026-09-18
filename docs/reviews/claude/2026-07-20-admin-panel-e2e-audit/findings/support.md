<!-- markdownlint-disable MD011 MD013 MD029 MD033 MD034 MD037 MD038 MD049 MD052 -->
<!-- WHY: imported verbatim FE<->BE<->DB audit evidence. The quoted TypeScript is
     what makes a finding checkable, and markdown's inline rules cannot tell it
     from markup: `Record<string, T>` and `[P]['req']` read as inline HTML and a
     reference link, `(typeof X)[number]` as a reversed link, snake_case
     fragments as emphasis, a template literal as a code span with spaces, an
     internal service URL as a bare URL, and an inline "1)" enumeration as an
     ordered list that starts at 2. Long lines are identifier-dense finding
     titles and evidence paths that cannot wrap without breaking the reference.
     Reflowing them would corrupt the record this file exists to preserve --
     the same rationale scripts/ci/markdownlint-changed.mjs states for its
     changed-line filter. Structure is enforced by the parsers instead:
     tools/gates/finding-registry.ts and tools/gates/commit-msg-validator.ts. -->

# Support (Tickets/Messaging/Announcements/Onboarding) — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the
> verified severity where status is CONFIRMED, else the auditor's grade pending verification.

## TicketsPage — `/admin/support/tickets` — verdict: **BROKEN**

**Chain:** FE (pages/TicketsPage.tsx) -> supportApi (services/api/support.ts) ->
/api/support/tickets* -> nginx rewrite to /api/v1/* (infrastructure/nginx/droplet.conf:377-383) ->
admin-api TicketController ('support/tickets', global prefix api/v1 + VERSION_NEUTRAL from
bootstrap) -> TicketService -> TypeORM -> admin.support_tickets / admin.ticket_comments (created in
apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:88,95; entities declare schema
'admin' per ADR-011). Auth is solid: global APP_GUARD PlatformAdminGuard enforces RS256 JWT +
SUPER_ADMIN on every route (app.module.ts:283-290; platform-admin.guard.ts:151-179). But the page
cannot fulfill its purpose: tenant-created tickets live in a separate silo (auth.support_tickets via
auth-service GraphQL consumed by tenant-admin) and never appear here; ticket creation 500s on a
hardcoded non-UUID createdBy; assignment always 500s (authorId 'system' into uuid column); the
comment thread never renders (pagination-envelope shape mismatch); every list filter 400s
(forbidNonWhitelisted vs mixed @Query pattern).

**Endpoints exercised:** `GET /api/support/tickets`; `GET /api/support/tickets/stats`;
`GET /api/support/tickets/team`; `GET /api/support/tickets/:id/comments`;
`POST /api/support/tickets/:id/comments`; `POST /api/support/tickets/:id/assign`;
`POST /api/support/tickets/:id/status`; `POST /api/support/tickets/:id/priority`;
`POST /api/support/tickets (not exposed in page UI; always fails)`;
`POST /api/support/tickets/:id/satisfaction (unused; FE payload always 400s)`

**DB tables:** `admin.support_tickets`, `admin.ticket_comments`,
`auth.support_tickets (tenant silo, never read by this page)`, `auth.ticket_comments (tenant silo)`

### APA-185 [CRITICAL] Ticket assignment always 500s: authorId 'system' inserted into uuid NOT NULL column

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** TicketService.assignTicket adds a system comment with authorId: 'system' before
  saving the assignment. admin.ticket_comments.authorId is uuid NOT NULL (entity @Column type
  'uuid'; Baseline migration line 95: authorId uuid NOT NULL). Postgres rejects 'system' with
  invalid-uuid, the request 500s, and the assignment is never persisted. The FE swallows the error
  (console.error only), so the assign dropdown silently does nothing.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/ticket.service.ts:334-340 (authorId: 'system')`
  - `apps/admin-api-service/src/support/entities/support.entity.ts:344-347 (@Column type 'uuid' authorId)`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:95 (authorId uuid NOT NULL)`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx:287-316 (handleAssign, catch -> console.error only)`
- **Verification:** Confirmed end-to-end against current code. FE dropdown
  (web/modules/admin-panel/src/pages/TicketsPage.tsx:617-633) calls supportApi.assignTicket
  (services/api/support.ts:43-44) -> POST /api/v1/support/tickets/:id/assign ->
  TicketController.assignTicket (ticket.controller.ts:300-310, DTO passes whitelist ValidationPipe)
  -> TicketService.assignTicket (ticket.service.ts:319-343), which awaits addComment with authorId:
  'system' (line 335) BEFORE ticketRepository.save (line 342). admin.ticket_comments.authorId is
  uuid NOT NULL in both the entity (support.entity.ts:347-348) and Baseline migration
  (1800000000000-Baseline.ts:95); grep across all 18 later migrations (incl.
  AlignAdminTenantColumnsToUuid) shows none relax it. Postgres raises 22P02 for 'system';
  GlobalExceptionFilter (filters/global-exception.filter.ts:99-160) special-cases only
  23505/23503/23502, so it returns 500 'Database operation failed'. The ticket save on line 342 is
  never reached, so the assignment is never persisted. FE catch is console.error-only
  (TicketsPage.tsx:313-315) and the select binds to the unchanged selectedTicket.assignedTo, so the
  UI silently snaps back. Every assignment attempt fails deterministically; severity stays CRITICAL:
  a core support workflow (assignment, which also gates the open->in_progress transition and feeds
  getTicketTeam) is 100 percent inoperative with silent failure. Refutations attempted and failed:
  no alternate FE route, no column relaxation, no transformer, filter cannot rescue it, UI
  reachable.
- **Root cause:** The persistence link of the chain broke: the domain type union authorType
  'admin'|'tenant_user'|'system' declares a system-actor concept that the storage contract (authorId
  uuid NOT NULL) cannot represent, and assignTicket papered over the unrepresentable variant with
  the sentinel string 'system'. It drifted because assignTicket is the only action endpoint in
  ticket.controller.ts that does not accept @CurrentUser() — siblings changeStatus (lines 312-328),
  changePriority (330-346), and addComment (366-386) all attribute audit comments to the acting
  admin's real uuid. This is an instance of a systemic class in this controller: sentinel-string
  actor identity injected into uuid columns instead of flowing identity from auth context (second
  instance: createdBy: 'tenant-user-id' at ticket.controller.ts:269 into support_tickets.createdBy
  uuid NOT NULL — ticket creation 500s identically; sibling finding). Secondary defect exposed by
  the same path: the two writes (comment insert, ticket save) are non-atomic and ordered
  comment-first, so any midway failure leaves an orphaned 'assigned to X' comment with no
  assignment.
- **Fix design:** Tier-1 (make wrong behavior impossible), fixed at the contract source across
  entity + migration + service + controller + FE types, plus the pattern-level rule. (1) Attribute
  assignment to the real actor, matching the established sibling pattern:
  TicketController.assignTicket gains @CurrentUser() user: CurrentUserData and passes the actor into
  TicketService.assignTicket(ticketId, assignedTo, assignedToName, actor: {id, name}); the audit
  comment becomes authorType 'admin', authorId actor.id (the admin who performed the assignment —
  semantically correct, it is not a system action). (2) Make the 'system' author variant
  representable instead of a lie, since genuine system actors exist in this module (checkSLABreaches
  cron, messaging senderType 'system'): entity authorId becomes @Column({ type: 'uuid', nullable:
  true }) authorId!: string | null; new migration alters admin.ticket_comments.authorId DROP NOT
  NULL and adds CHECK constraint chk_ticket_comments_author_pairing ((authorType = 'system' AND
  "authorId" IS NULL) OR (authorType <> 'system' AND "authorId" IS NOT NULL)) so the DB structurally
  rejects any future sentinel. (3) Compile-time contract: replace addComment's inline author fields
  with an exported discriminated union TicketCommentAuthor = { authorType: 'system'; authorName:
  string } | { authorType: 'admin' | 'tenant_user'; authorId: string; authorName: string } — passing
  authorId with the system variant becomes a tsc error; caught platform-wide by npm run type-check.
  (4) Atomicity: wrap assignTicket's ticket save + comment insert in one dataSource.transaction
  using manager-scoped repositories, ticket state first, so no orphaned audit comment can persist.
  (5) FE contract alignment: TicketComment.authorId: string | null in services/types/support.ts, the
  inline getTicketComments type in services/api/support.ts, and the comment mapping in
  TicketsPage.tsx:181; handleAssign's catch sets the page's existing error state instead of
  console.error-only so failures are visible (the silent-swallow is part of this finding's blast
  radius). Pattern-level rule for the systemic class: actor identity always flows from
  @CurrentUser() into service methods — never string literals; the DB CHECK plus the discriminated
  union are the enforcement gates. The sibling instance (createdBy: 'tenant-user-id',
  ticket.controller.ts:269) must be tracked as its own finding and fixed with the same pattern.
- **Files to change:**
  - `apps/admin-api-service/src/support/services/ticket.service.ts`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts`
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `apps/admin-api-service/src/migrations/1801600000000-TicketCommentAuthorPairing.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx`
  - `apps/admin-api-service/src/support/__tests__/ticket.service.spec.ts`
  - `apps/admin-api-service/src/__tests__/api/ticket-assign.spec.ts`
- **Proof of fix:** Add apps/admin-api-service/src/**tests**/api/ticket-assign.spec.ts (supertest
  style like the existing src/**tests**/api/error-format.spec.ts): POST /support/tickets/:id/assign
  as an authenticated SUPER_ADMIN returns 200 with the envelope; follow-up GET :id shows assignedTo
  persisted and status in_progress; GET :id/comments contains exactly one assignment comment with
  authorType 'admin' and authorId equal to the acting admin's uuid (asserts the sentinel is gone and
  attribution is correct). Extend
  apps/admin-api-service/src/support/**tests**/ticket.service.spec.ts (London-school, mocked repos):
  assignTicket writes ticket and comment inside one transaction and never passes a non-uuid
  authorId; the discriminated union makes the old call shape (authorId with authorType 'system') a
  compile error, enforced by npm run type-check in CI. DB-contract invariant: extend
  apps/admin-api-service/src/**tests**/contract-validation.spec.ts (or the migrations **tests**
  suite) to assert the chk_ticket_comments_author_pairing CHECK exists and that INSERTs violating
  either pairing direction (system + non-null authorId; admin + null authorId) are rejected by
  Postgres. All via nx affected --target=test.
- **Effort:** M

### APA-186 [HIGH] POST /support/tickets always 500s: hardcoded createdBy 'tenant-user-id' into uuid NOT NULL column

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** TicketController.createTicket passes createdBy: 'tenant-user-id' (comment admits 'In
  production, would come from auth context') into admin.support_tickets.createdBy which is uuid NOT
  NULL. Every create request fails at insert. Additionally the FE supportApi.createTicket sends a
  'createdBy' field the DTO lacks and omits the required 'createdByName', so with the global
  forbidNonWhitelisted ValidationPipe the call would 400 before even reaching the 500. Ticket
  creation is doubly broken end-to-end (the page exposes no create UI, so tickets can effectively
  never enter this system at all).
- **Evidence:**
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts:266-278 (createdBy: 'tenant-user-id')`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:88 (createdBy uuid NOT NULL)`
  - `web/modules/admin-panel/src/services/api/support.ts:36-37 (payload has createdBy, no createdByName)`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts:33-65 (CreateTicketDto: createdByName required, no createdBy)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-460 (whitelist + forbidNonWhitelisted defaults)`
- **Verification:** Confirmed at every layer by re-reading current code. (1) Route reachable:
  TicketController registered in SupportModule -> AppModule; nginx /api -> /api/v1 ->
  globalPrefix+VERSION_NEUTRAL. (2) 400 layer: admin main.ts passes no validationPipeOverrides, so
  create-service-app.ts defaults whitelist:true+forbidNonWhitelisted:true apply; FE payload
  (support.ts:36) carries 'createdBy' which CreateTicketDto (ticket.controller.ts:33-65) lacks ->
  rejected; FE also omits required 'createdByName' -> second 400. (3) 500 layer: a DTO-conformant
  payload still hits hardcoded createdBy:'tenant-user-id' (ticket.controller.ts:269), passed
  verbatim by TicketService.createTicket (ticket.service.ts:83) into
  admin.support_tickets."createdBy" uuid NOT NULL (Baseline.ts:88; entity support.entity.ts:259
  @Column({type:'uuid'})); Postgres 22P02 -> 500. All 19 later admin migrations checked — none
  alters this column. (4) No alternate producer: no other service posts to this endpoint and no
  admin-panel page calls supportApi.createTicket, so tickets can never enter the system. Severity
  corrected CRITICAL->HIGH: the endpoint fails 100% of the time, but no shipped UI reaches it, so no
  user-facing workflow actually crashes; impact is complete latent inoperability of the
  support-ticket subsystem (list/stats pages permanently empty), with no security or data-integrity
  dimension. This is a confirmed instance of the systemic FE-payload-drift class: the existing
  contract-validation.spec.ts gate matches URL+method only, so request-body field drift is
  structurally invisible to CI.
- **Root cause:** The creator-identity link of the FE->BE->DB chain was never wired to the auth
  context. CreateTicketDto was designed for a hypothetical tenant-user submission flow, but the
  service runs behind the global SUPER_ADMIN PlatformAdminGuard where the authenticated admin
  (CurrentUserData.id, a verified uuid from the RS256 JWT) is available on every request — the same
  controller already consumes @CurrentUser() correctly in changeStatus/changePriority/addComment,
  yet createTicket shipped with a placeholder literal ('tenant-user-id', comment admits it) that can
  never satisfy the uuid NOT NULL column. Independently, the FE api function was hand-written
  against an imagined contract (sends createdBy, omits createdByName) — hand-written FE types with
  no body-level contract gate: contract-validation.spec.ts proves URL+method parity only, so field
  drift and the guaranteed forbidNonWhitelisted 400 were undetectable at build/test time, and no
  integration test ever exercised POST /support/tickets.
- **Fix design:** Tier 1-2 local fix (make fabricated identity impossible, correct identity
  automatic): in ticket.controller.ts createTicket, inject @CurrentUser() user: CurrentUserData and
  pass createdBy: user.id (delete the 'tenant-user-id' literal and its comment); default
  createdByEmail to dto.createdByEmail ?? user.email. createdBy is never client-supplied — it is the
  authenticated actor, so a forged/invalid creator id is structurally impossible; the on-behalf-of
  person remains the existing createdByName/createdByEmail display fields. Align the DTO with the DB
  contract at the source: tenantId gets @IsUUID() (column is uuid NOT NULL — a non-uuid tenantId is
  the same 22P02->500 class), and drop the redundant manual if(!dto...) check the ValidationPipe
  already enforces. FE side: rewrite supportApi.createTicket's payload type in
  web/modules/admin-panel/src/services/api/support.ts to exactly the DTO shape — { tenantId,
  subject, description, createdByName, createdByEmail?, tenantName?, category?, priority?, tags? } —
  removing createdBy (server-derived). Tier 3 pattern-level fix for the systemic FE-payload-drift
  class: extend the existing static gate
  apps/admin-api-service/src/**tests**/contract-validation.spec.ts (it already parses both sides
  with the TS compiler API) with a request-body dimension — for each FE apiFetch POST/PUT whose body
  is a typed object literal, extract payload property names and assert every property exists on the
  matched handler's @Body() DTO class (given the global forbidNonWhitelisted pipe, any FE-only field
  is mechanically a 400, so the invariant is statically enforceable); seed it with the support
  domain and walk all api files. Note for the audit ledger: the absence of any create-ticket UI on
  TicketsPage is a distinct product-completeness gap that should carry its own finding ID in the
  support section; this fix makes any future create UI correct by construction.
- **Files to change:**
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`
  - `apps/admin-api-service/src/support/__tests__/ticket.controller.spec.ts`
- **Proof of fix:** New unit spec
  apps/admin-api-service/src/support/**tests**/ticket.controller.spec.ts (London school, mock
  TicketService): (a) createTicket forwards createdBy === user.id from CurrentUserData and the
  literal 'tenant-user-id' appears nowhere in the controller source; (b) a DTO instance built from
  the exact FE payload type in support.ts passes class-validator validate() with
  whitelist+forbidNonWhitelisted (proves no 400) — this assertion fails today on both the extra
  createdBy field and the missing createdByName. Extended
  apps/admin-api-service/src/**tests**/contract-validation.spec.ts: request-body field-parity walker
  asserting every FE POST/PUT payload property exists on the matched controller DTO — fails red on
  current support.ts before the fix, green after, and permanently gates the whole systemic class
  across all admin api files.
- **Effort:** M

### APA-187 [HIGH] Ticket comments never display: paginated backend response mapped as an array by the FE

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** TicketService.getComments returns {data,total,page,limit}; the ResponseInterceptor
  lifts total/page/limit into meta; http-client sees meta.page and returns {data,...meta} (an
  object). TicketsPage.fetchComments does (data || []).map(...) on that object, throwing TypeError
  ('.map is not a function'), which the catch swallows. The comment thread permanently shows 'No
  comments yet' even when comments exist, and after posting a comment (which persists fine) the
  refresh still renders nothing. Same defect applies to the unused getTicketReplies.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/ticket.service.ts:482-499 (returns {data,total,page,limit})`
  - `apps/admin-api-service/src/shared/response.interceptor.ts:44-65 (pagination -> meta)`
  - `web/modules/admin-panel/src/services/http-client.ts:342-349 (meta.page -> returns {data,...meta})`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx:173-200 ((data || []).map on object; catch -> console.error)`
  - `web/modules/admin-panel/src/services/api/support.ts:63 (declares Array return type)`
- **Verification:** Every link verified in current code. (1) BE: GET /support/tickets/:id/comments
  (ticket.controller.ts:352-364) returns ticketService.getComments() verbatim, which returns
  {data,total,page,limit} with page defaulting to 1 (ticket.service.ts:482-499), so page is ALWAYS
  present. (2) ResponseInterceptor is registered as global APP_INTERCEPTOR (app.module.ts:292-293);
  its 'data' in data && 'total' in data branch (response.interceptor.ts:44-65) lifts
  total/page/limit into meta. (3) FE http-client.ts:341-349: parseApiEnvelope matches (success+data
  keys), then `'page' in envelope.meta` is true, so apiFetch returns
  {data:[...],total,page,limit,totalPages,timestamp} — an object — laundered into the declared array
  type by the `as T` cast. (4) support.ts:63 declares Array<...>; TicketsPage.tsx:178 does (data ||
  []).map — data is a truthy object with no .map, so a TypeError is thrown, caught at :195-196
  (console.error only), setComments is never called, and comments stays at its initial [] (line 91)
  — the thread permanently renders the empty state, including after a successful POST (single-object
  response unwraps fine, but the refresh re-throws). (5) getTicketReplies (support.ts:35, typed
  TicketReply[]) hits /replies (controller :392-405) which returns the identical paginated shape —
  same latent defect, currently unconsumed. Adversarial checks: no alternate route or interceptor
  skip applies (SKIP_PREFIXES only covers /health//docs); the endpoint sends no query params so
  ValidationPipe whitelisting is not in play; nginx rewrite is irrelevant to response shape.
  Severity HIGH is correct: a P0 support page's core function (reading the comment thread) is
  completely and silently broken for admins, but there is no data loss or security impact, so not
  CRITICAL. This is an instance of the systemic class 'paginated-envelope/FE-type drift':
  apiFetch<T> changes its runtime return shape based on hidden response metadata (meta.page) while T
  is an unchecked cast, so nothing binds an endpoint's declared type to whether the controller
  paginates — getTickets got it right by hand, getTicketComments/getTicketReplies drifted. The
  `att.fileName || att.filename` dual-key guessing at TicketsPage.tsx:189 is collateral evidence of
  the same untyped-contract drift (backend TicketAttachment is fileName/fileSize,
  support.entity.ts:465-472).
- **Root cause:** The FE type link of the FE->BE chain broke: the backend endpoint is paginated
  (findAndCount) and the interceptor+http-client faithfully deliver PaginatedResult-shaped data, but
  the hand-written api-fn signature (support.ts:63) declares a bare array, and apiFetch's unchecked
  `as T` cast lets the false type through the compiler; TicketsPage then consumes per the false type
  and its catch-all swallow converts the TypeError into a silent empty thread. It drifted because
  the http-client picks between two structurally different return shapes AT RUNTIME (keyed on
  meta.page) while per-endpoint types are hand-written with no contract binding them to the
  controller's actual return shape — the compiler structurally cannot catch the mismatch.
- **Fix design:** Pattern-level (tier 1 — make the wrong pairing impossible): remove the runtime
  shape-shifting from apiFetch. In web/modules/admin-panel/src/services/http-client.ts: (a)
  apiFetch<T> always returns envelope.data (delete the `meta.page → {data,...meta}` merge at lines
  344-346); (b) add `apiFetchPaginated<T>(endpoint, options?): Promise<PaginatedResult<T>>` which
  REQUIRES a paginated envelope — it validates meta.page/total/limit are numbers and throws a
  descriptive contract-violation ApiError otherwise (no silent fallback). The caller's choice of
  function now statically determines the shape, and a paginated/plain mismatch fails loudly at
  runtime instead of being silently reshaped. Mechanically migrate all 41 existing
  `apiFetch<PaginatedResult<...>>` callsites across the 13 services/api/_.ts files to
  apiFetchPaginated (same declared types, no behavior change for them). Local application: in
  services/api/support.ts retype getTicketComments as apiFetchPaginated<TicketComment> using the
  existing TicketComment interface from services/types/support.ts (delete the inline anonymous type
  — one source of truth), and retype getTicketReplies as apiFetchPaginated<TicketComment> since the
  backend /replies alias returns TicketComment rows, not the fictional TicketReply shape. Align
  TicketAttachmentInfo in services/types/support.ts field-for-field with the backend
  TicketAttachment jsonb contract (fileName/fileSize/mimeType/url/uploadedAt,
  support.entity.ts:465-472). In TicketsPage.tsx fetchComments: consume
  `const { data } = await supportApi.getTicketComments(id)` and delete the entire
  Record<string,unknown> re-mapping block including the defensive `att.fileName || att.filename`
  guessing (the typed contract makes it dead); replace the console.error-only catch with an error
  state rendered in the comments panel so future contract breaks are visible, not swallowed
  (console._ is banned repo-wide anyway).
- **Files to change:**
  - `web/modules/admin-panel/src/services/http-client.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx`
  - `web/modules/admin-panel/src/services/api/reports.ts`
  - `web/modules/admin-panel/src/services/api/modules.ts`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `web/modules/admin-panel/src/services/api/tenants.ts`
  - `web/modules/admin-panel/src/services/api/audit.ts`
  - `web/modules/admin-panel/src/services/api/security.ts`
  - `web/modules/admin-panel/src/services/api/database.ts`
  - `web/modules/admin-panel/src/services/api/analytics.ts`
  - `web/modules/admin-panel/src/services/api/debug.ts`
  - `web/modules/admin-panel/src/services/api/messaging.ts`
  - `web/modules/admin-panel/src/services/api/settings.ts`
  - `web/modules/admin-panel/src/services/api/users.ts`
- **Proof of fix:** Add
  web/modules/admin-panel/src/services/**tests**/http-client.pagination.spec.ts: feed
  interceptor-real envelopes ({success:true,data:[...],meta:{total,page,limit,timestamp}} and
  {success:true,data:{...},meta:{timestamp}}) and assert apiFetch returns bare data,
  apiFetchPaginated returns a full PaginatedResult, and apiFetchPaginated throws a
  contract-violation error on a non-paginated envelope (tier-3 gate for the whole systemic class).
  Add regression spec web/modules/admin-panel/src/pages/**tests**/TicketsPage.comments.spec.tsx:
  mock fetch for /support/tickets/:id/comments with the exact ResponseInterceptor envelope and
  assert the comment content renders (fails on the pre-fix code with 'No comments yet'). Pin the BE
  side by extending apps/admin-api-service/src/support/**tests** controller coverage to assert GET
  :id/comments returns {data,total,page,limit} so the interceptor's pagination branch is guaranteed
  to engage.
- **Effort:** M

### APA-188 [HIGH] Any status/priority/category filter selection makes GET /support/tickets return 400

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** TicketController.getAllTickets binds named filters AND @Query() PaginationQueryDto on
  the same route. The global ValidationPipe (whitelist + forbidNonWhitelisted) validates the whole
  query object against PaginationQueryDto, so extra keys like
  status/priority/category/search/tenantId/assignedTo are rejected with 400 'property ... should not
  exist'. The default load (limit=100 only) works, but selecting any filter in the page flips the
  whole list into the error state. Same landmine on getTicketsForTenant, getAssignedTickets and
  getComments (when includeInternal is passed).
- **Evidence:**
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts:162-182 (named @Query + @Query() PaginationQueryDto)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-460 (forbidNonWhitelisted: true global default; admin-api main.ts passes no overrides)`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:4-25 (DTO has only page/limit/sortBy/sortOrder)`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx:108-113 (adds status/priority/category params)`
- **Verification:** Confirmed reachable end-to-end. FE (TicketsPage.tsx:108-113) sends
  status/priority/category; buildQueryString (http-client.ts:384-390) comma-joins arrays into single
  keys, so the request is /support/tickets?limit=100&status=open. NestJS validates each route param
  independently: named @Query('x') params have primitive metatypes and skip the ValidationPipe, but
  @Query() pagination?: PaginationQueryDto (ticket.controller.ts:170) receives the ENTIRE req.query.
  The platform-global pipe (create-service-app.ts:458-460, whitelist+forbidNonWhitelisted; admin-api
  main.ts passes no overrides, no APP_PIPE/@UsePipes anywhere in production code) rejects
  status/priority/category/search/tenantId/assignedTo as non-whitelisted against PaginationQueryDto
  (only page/limit/sortBy/sortOrder) -> 400 -> apiFetch throws -> page flips to error state with an
  empty list. Same landmine verified on getTicketsForTenant (:236), getAssignedTickets (:249),
  getComments/getReplies (:357/:397 when includeInternal is sent), billing listCustomPlans
  (billing.controller.ts:532-538), and audit queryAuditLogs (audit.controller.ts:42-54). Refutation
  attempts failed: TS optionality is runtime-erased (req.query always validated); no
  route/controller pipe overrides; nginx rewrite only changes the path prefix. Existing specs never
  caught it because they construct laxer local pipes (e.g. tenant.integration.spec.ts:345 omits
  forbidNonWhitelisted). HIGH stands: core filter interaction of a P0 admin page deterministically
  400s the entire list, and the same class breaks audit-log and custom-plan filtering. Systemic
  class: DTO-whitelist rejection via mixed named-@Query + whole-object-DTO; the correct single-DTO
  pattern already exists in the same service (QueryActivitiesDto in activity-log.controller.ts:226,
  QueryDataRequestsDto in compliance.controller.ts:249) — those grep hits were multiline-window
  artifacts, not violations.
- **Root cause:** The BE controller layer broke the FE->BE contract: the query contract for
  filterable list routes was never reified into a single validated type. NestJS's per-parameter
  validation means named @Query('x') primitives bypass the DTO entirely while the bolted-on @Query()
  PaginationQueryDto is validated against the FULL query object, so under the platform's security
  default (forbidNonWhitelisted) every documented filter key is treated as an unknown property. It
  drifted because (a) PaginationQueryDto was retrofit onto routes that already had ad-hoc named
  filter params, (b) nothing at build/test time detects the mixed pattern, and (c) controller specs
  instantiate their own lax ValidationPipe instead of the production bootstrap options, so the prod
  pipe config is never exercised in tests; the FE default load (no filters) masked it at runtime.
- **Fix design:** Tier 1 (make wrong shape impossible) — one whole-object query DTO per route owns
  the complete contract, following the pattern already proven in this service
  (QueryActivitiesDto/QueryDataRequestsDto): (1) support/dto/ticket-query.dto.ts with
  ListTicketsQueryDto extends PaginationQueryDto adding @IsOptional @IsEnum(TicketStatus) status,
  @IsEnum(TicketPriority) priority, @IsEnum(TicketCategory) category, @IsString assignedTo,
  @IsString tenantId, @IsString search; TicketStatusScopedQueryDto extends PaginationQueryDto
  (status only) for tenant/:tenantId and assigned/:userId; TicketCommentsQueryDto extends
  PaginationQueryDto with includeInternal using explicit @Transform(({value}) => value !==
  'false') + @IsBoolean (enableImplicitConversion stays off by design — the DTO owns the coercion,
  matching the controller's current `!== 'false'` semantics). Controller signatures collapse to a
  single @Query() query: XxxDto; getReplies reuses TicketCommentsQueryDto. (2) Apply the identical
  fix to the two sibling instances the pattern gate will flag: billing.controller.ts listCustomPlans
  -> ListCustomPlansQueryDto (tenantId/status/tier/search + pagination) and audit.controller.ts
  queryAuditLogs -> QueryAuditLogsDto (9 filters + pagination), each in the domain's dto/ dir per
  layer rules. (3) Align the FE contract at the source: supportApi.getTickets params currently
  declare TicketStatus[]/TicketPriority[]/TicketCategory[] while the service layer
  (ticket.service.ts:209-217) only supports scalar filters — narrow the FE param types to scalars
  and have TicketsPage pass `statusFilter` directly instead of wrapping in a single-element array,
  eliminating the latent CSV-array drift ('open,closed' would fail @IsEnum). Tier 3 (make violations
  detectable) — pattern-level gate: new architecture spec query-contract.architecture.spec.ts
  reflects over every controller registered in AppModule via ROUTE_ARGS_METADATA
  ('**routeArguments**') + design:paramtypes and FAILS any handler that declares both a class-typed
  whole-object @Query() (data undefined, non-primitive metatype) and any named @Query('key') param.
  Zero allowlist — which is why the billing and audit siblings must be fixed in the same commit.
  Tier 2 (make correct behavior automatic for tests) — export the production ValidationPipe defaults
  from create-service-app.ts as getDefaultValidationPipeOptions(isProduction) (pure extraction,
  configureValidationPipe consumes it; no behavior change) so integration specs boot with the REAL
  prod pipe config instead of hand-rolled lax pipes, closing the test-fidelity gap that hid this
  class.
- **Files to change:**
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts`
  - `apps/admin-api-service/src/support/dto/ticket-query.dto.ts`
  - `apps/admin-api-service/src/audit/audit.controller.ts`
  - `apps/admin-api-service/src/audit/dto/query-audit-logs.dto.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/dto/list-custom-plans-query.dto.ts`
  - `libs/backend-common/src/bootstrap/create-service-app.ts`
  - `apps/admin-api-service/src/__tests__/query-contract.architecture.spec.ts`
  - `apps/admin-api-service/src/support/__tests__/ticket.controller.integration.spec.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx`
- **Proof of fix:** Two gates. (1) New integration spec
  apps/admin-api-service/src/support/**tests**/ticket.controller.integration.spec.ts boots
  TicketController with the exported production pipe options (getDefaultValidationPipeOptions from
  backend-common, NOT a hand-rolled pipe) and asserts: GET
  /support/tickets?status=open&priority=high&category=technical&search=x&tenantId=t&assignedTo=u&limit=100
  returns 200 with the filter object forwarded to TicketService; GET
  /support/tickets/tenant/:id?status=open, /support/tickets/assigned/:id?status=open, and
  /support/tickets/:id/comments?includeInternal=false&page=1 return 200; a genuinely unknown key
  (?bogus=1) still returns 400, proving the forbidNonWhitelisted security default is retained, not
  weakened. (2) New architecture gate
  apps/admin-api-service/src/**tests**/query-contract.architecture.spec.ts iterates all AppModule
  controllers via ROUTE_ARGS_METADATA and fails any route mixing a named @Query('x') with a
  class-typed whole-object @Query() — passes only once ticket, billing, and audit controllers are
  converted, and structurally prevents recurrence of the class. Both run under nx affected
  --target=test.
- **Effort:** M

### APA-189 [MEDIUM] Ticket numbers generated from an in-memory counter: guaranteed unique-constraint collision after service restart

- **Status:** DESIGNED (brief)
- **Symptom:** generateTicketNumber increments a private field starting at 1000 per process. After
  any restart, the counter resets and the next create produces TKT-<year>-01001 again, violating the
  UNIQUE(ticketNumber) constraint and 500ing (once creation itself is fixed). Also collides across
  multiple replicas.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/ticket.service.ts:41 (private ticketCounter = 1000)`
  - `apps/admin-api-service/src/support/services/ticket.service.ts:103-107 (generateTicketNumber)`
  - `apps/admin-api-service/src/support/entities/support.entity.ts:250-251 (unique: true ticketNumber)`
- **Root cause:** Uniqueness of ticketNumber is enforced by the DB (unique: true) but generated from
  process-local mutable state (private ticketCounter = 1000 in TicketService). The counter resets on
  every restart and is not shared across replicas, so generateTicketNumber() re-issues
  TKT-<year>-01001 and the INSERT violates the unique constraint.
- **Fix design:** Tier 1 — move number generation into the database so collision is structurally
  impossible. New migration creates a Postgres sequence admin.support_ticket_number_seq and
  setval()s it above the max existing numeric suffix (parsed from
  admin.support_tickets.ticket_number). createTicket obtains the number via SELECT
  nextval('admin.support_ticket_number_seq') in the same transaction as the insert and formats
  TKT-<year>-<padded seq>. Delete the ticketCounter field and the in-memory generateTicketNumber
  logic entirely. Spec: two TicketService instances (simulated restart/replica) create tickets
  against the same DB and never collide; unit test asserts the service holds no counter state.
- **Files to change:**
  - `apps/admin-api-service/src/migrations/1801600000000-SupportTicketNumberSequence.ts`
  - `apps/admin-api-service/src/support/services/ticket.service.ts`
  - `apps/admin-api-service/src/support/__tests__/ticket.service.spec.ts`
- **Effort:** S

### APA-190 [MEDIUM] Internal notes and system status-change comments count as SLA 'first response'

- **Status:** DESIGNED (brief)
- **Symptom:** addComment sets firstResponseAt for ANY authorType 'admin' comment including
  isInternal notes, and changeStatus/changePriority create admin-authored internal comments, so
  merely changing status marks the ticket as responded and computes SLA compliance from it. SLA
  metrics (avgFirstResponseMinutes, slaBreached) are silently wrong.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/ticket.service.ts:458-468 (firstResponseAt on any admin comment)`
  - `apps/admin-api-service/src/support/services/ticket.service.ts:373-380 (changeStatus adds internal admin comment)`
- **Root cause:** addComment (ticket.service.ts:458) sets firstResponseAt for ANY
  authorType==='admin' comment, ignoring isInternal; changeStatus (373-380) and changePriority
  (408-414) create admin-authored isInternal comments for audit, so a mere status flip records a
  'first response' and drives avgFirstResponseMinutes/slaBreached. SLA semantics ('customer-visible
  reply') are conflated with 'any admin comment' and the audit-comment authorship is wrong.
- **Fix design:** Encode the SLA rule in one named predicate isSlaFirstResponse(comment): authorType
  === 'admin' && !isInternal, used by addComment. Additionally reclassify the status/priority-change
  audit comments as authorType 'system' (like assignTicket already does), keeping the acting admin
  in authorId/authorName — they are events, not responses. Spec: internal admin note does NOT set
  firstResponseAt; status/priority change does NOT; a public admin reply DOES and computes
  slaBreached from slaResponseMinutes. Note this also corrects
  getTicketStats().avgFirstResponseMinutes downstream with no further change.
- **Files to change:**
  - `apps/admin-api-service/src/support/services/ticket.service.ts`
  - `apps/admin-api-service/src/support/__tests__/ticket.service.spec.ts`
- **Effort:** S

### APA-191 [MEDIUM] FE contract drift on stats/by-category, stats/by-priority, sla-risk and satisfaction endpoints

- **Status:** DESIGNED (brief)
- **Symptom:** supportApi types expect Array<{category,count,avgResolutionTime}> and
  Array<{...hoursUntilBreach,tenantName}> but the backend returns Record<category,number> / raw
  SupportTicket[] respectively; submitSatisfaction sends a 'submittedBy' field the DTO lacks, so it
  400s under forbidNonWhitelisted. None are used by TicketsPage today, but any consumer of these api
  functions misrenders or fails.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/support.ts:49-61 (declared shapes)`
  - `apps/admin-api-service/src/support/services/ticket.service.ts:655-682 (Record returns)`
  - `apps/admin-api-service/src/support/services/ticket.service.ts:559-571 (sla-risk returns entities)`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts:140-147 (SatisfactionRatingDto: rating+feedback only)`
- **Root cause:** Instance of the systemic FE-type-drift class: hand-written types in
  web/modules/admin-panel/src/services/api/support.ts were authored against an imagined API.
  getStatsByCategory/getStatsByPriority return Record<enum, number> (ticket.service.ts:655-682)
  while FE declares Array<{category,count,avgResolutionTime}>; sla-risk returns raw SupportTicket[]
  entities (559-571) while FE expects {hoursUntilBreach,tenantName} summaries; submitSatisfaction
  posts submittedBy which SatisfactionRatingDto (controller:140-147) whitelists away → 400 under
  forbidNonWhitelisted.
- **Fix design:** Fix the contract at the source, backend-first, then align FE to it. (a) Backend:
  give the three read endpoints purpose-built typed response DTOs — stats/by-category and
  stats/by-priority return Array<{category|priority, count}> (drop the fictional avgResolutionTime,
  or compute it if product wants it); sla-risk returns Array<{id, ticketNumber, subject, priority,
  tenantId, tenantName, dueAt, minutesUntilBreach}> computed server-side from dueAt. (b) FE: update
  supportApi return types to the exact DTO shapes; delete submittedBy from submitSatisfaction — the
  admin JWT (CurrentUser) is the actor identity, the DTO stays rating+feedback. (c) Pattern-level
  gate: add a support-contract spec that boots the controller and asserts serialized response shapes
  structurally match the FE-declared types for every supportApi read endpoint (extend the existing
  admin FE/BE contract-test approach), so future drift fails CI. Say-so: this is the
  shared-contract/codegen class — the durable fix is a single shared TS contract module (or
  OpenAPI-generated types) consumed by both sides; this finding lands the support-domain slice of
  it.
- **Files to change:**
  - `apps/admin-api-service/src/support/services/ticket.service.ts`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `apps/admin-api-service/src/support/__tests__/support-contract.spec.ts`
- **Effort:** M

### APA-192 [MEDIUM] All mutation failures swallowed with console.error; no user feedback or rollback

- **Status:** DESIGNED (brief)
- **Symptom:** handleAssign/handleStatusChange/handlePriorityChange/handleAddComment catch errors
  and only console.error. Given assignment always 500s and filters 400, the operator sees no error
  UI; status/priority selects also optimistically update selectedTicket state before server
  confirmation in the failure path.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx:313-315`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx:326-328`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx:338-340`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx:355-357`
- **Root cause:** Instance of the systemic silent-mutation-failure class:
  handleAssign/handleStatusChange/handlePriorityChange/handleAddComment (TicketsPage.tsx:313-357)
  catch and console.error only — no user-visible feedback (console.\* is also banned repo-wide).
  (Sub-claim correction: setSelectedTicket runs after the awaited call succeeds, so there is no
  pre-confirmation optimistic write; the real defect is purely the swallowed error.)
- **Fix design:** Tier 2 — make correct feedback automatic. Add an admin-panel mutation hook
  (useAdminMutation) that wraps a supportApi call, on success runs the refetch callbacks, and on
  failure surfaces the server error via the existing shared-ui useToast + ToastContainer (mounted
  once at the admin-panel page shell) using useErrorMessage for the text; no catch blocks in page
  code at all. Convert the four TicketsPage handlers to it and delete every console.error. This is
  the same fix as support|p2|i4 — one hook, applied per page. Spec: TicketsPage test mocks a
  rejected updateTicketStatus and asserts an error toast renders and selectedTicket state is
  unchanged.
- **Files to change:**
  - `web/modules/admin-panel/src/hooks/useAdminMutation.ts`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/TicketsPage.spec.tsx`
- **Effort:** M

### APA-193 [LOW] commentCount hardcoded to 0 in the ticket list

- **Status:** DESIGNED (brief)
- **Symptom:** The list badge always shows 0 comments ('Not provided by API' per the FE comment);
  the backend exposes no comment count on the list endpoint.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx:130 (commentCount: 0, // Not provided by API)`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx:537-540 (renders ticket.commentCount)`
- **Root cause:** The list endpoint returns bare SupportTicket rows with no comment count, so the FE
  hardcodes commentCount: 0 (TicketsPage.tsx:130) yet renders it as a badge (537-540) — a
  config-value-nobody-provides gap in the list contract.
- **Fix design:** Provide the count at the source, derived not denormalized. TypeORM 0.3.27 supports
  @VirtualColumn: add commentCount to SupportTicket as @VirtualColumn({ query: alias =>
  `SELECT COUNT(*) FROM admin.ticket_comments c WHERE c."ticketId" = ${alias}.id` }) so every SELECT
  of the entity carries it automatically (tier 2, no writes to keep in sync). Remove the FE
  hardcoded 0 and map ticket.commentCount from the API row; add commentCount to the FE SupportTicket
  type. Spec: ticket.service list test asserts commentCount equals the number of persisted comments;
  the support-contract spec (from support|p0|i6) asserts the field is present on the list shape.
- **Files to change:**
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `apps/admin-api-service/src/support/__tests__/ticket.service.spec.ts`
- **Effort:** S

## MessagingPage — `/admin/support/messaging` — verdict: **PARTIAL**

**Chain:** FE (pages/MessagingPage.tsx) -> supportApi -> /api/support/messages/\* -> admin-api
MessagingController ('support/messages') -> MessagingService -> admin.message_threads /
admin.messages (Baseline.ts:72-78,242; schema 'admin' declared) plus auth.tenants via TenantReadOnly
for bulk targeting. All routes SUPER_ADMIN-guarded globally. Thread list, thread messaging,
close/reopen/archive and stats hit real tables and work in isolation. However the whole silo is
one-way dead-ended: no tenant-facing surface reads admin.message_threads (tenant-admin uses
auth-service GraphQL MySupportThreads against the auth schema), the email TODO is unimplemented, so
nothing an admin sends here ever reaches a tenant. Bulk Message always 400s. Field-name drift makes
unread counts and closed state invisible and misaligns admin messages.

**Endpoints exercised:** `GET /api/support/messages/threads`;
`GET /api/support/messages/threads/:threadId/messages`; `POST /api/support/messages/threads`;
`POST /api/support/messages/threads/:threadId/messages`;
`POST /api/support/messages/threads/:threadId/read`;
`POST /api/support/messages/threads/:threadId/close`;
`POST /api/support/messages/threads/:threadId/reopen`;
`POST /api/support/messages/threads/:threadId/archive`; `POST /api/support/messages/bulk`;
`GET /api/support/messages/stats`

**DB tables:** `admin.message_threads`, `admin.messages`, `auth.tenants (read-only, bulk targeting)`

### APA-194 [HIGH] Bulk Message always fails with 400 'No target tenants specified'

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** The BulkMessageModal collects only subject/content/sendEmail and handleBulkMessage
  forwards exactly that; it never sends tenantIds or targetCriteria. The controller only resolves
  target tenants via getTargetTenants when dto.targetCriteria is present, so tenantIds stays [] and
  it throws BadRequestException. The UI even promises 'This message will be sent to all active
  tenants' — it is never sent to anyone; the error is swallowed by console.error and the modal stays
  open with no feedback. The primary broadcast flow of this page cannot succeed.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx:226-235 (handleBulkMessage payload)`
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx:661-669 (modal submits {subject,content,sendEmail} only)`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts:221-230 (tenantIds [] -> BadRequestException)`
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx:727-729 ('sent to all active tenants' claim)`
- **Verification:** Confirmed end-to-end. BulkMessageModal
  (web/modules/admin-panel/src/pages/MessagingPage.tsx:666-670) submits only {subject, content,
  sendEmail}; supportApi.sendBulkMessage (services/api/support.ts:88-89) POSTs it verbatim to
  /support/messages/bulk; the route is live (SupportModule in
  apps/admin-api-service/src/app.module.ts:229, MessagingController in support.module.ts:53) and
  reachable via nginx /api -> /api/v1. In the controller (messaging.controller.ts:211-243) all
  targeting fields are @IsOptional so ValidationPipe passes the payload; tenantIds = dto.tenantIds
  || [] stays [], getTargetTenants only runs when dto.targetCriteria is present (never), so
  BadRequestException('No target tenants specified') fires on EVERY invocation. The error is
  swallowed by console.error and setShowBulkModal(false) sits inside the try, so the modal stays
  open with no feedback. No alternate route, interceptor, or default supplies a target. Downgraded
  CRITICAL->HIGH: total functional failure of the page's primary broadcast flow with silent error
  swallowing, but admin-only, no data corruption, no security/cross-tenant impact, and a manual
  workaround exists (per-tenant New Conversation). Notably getTargetTenants({}) already returns all
  ACTIVE tenants — the 'all active tenants' semantics exists server-side; the FE just never sends
  targetCriteria: {}.
- **Root cause:** The FE->BE contract link broke: the backend's semantic precondition ('must supply
  non-empty tenantIds or targetCriteria'; broadcast-to-all is only expressible as targetCriteria:
  {}) exists solely as a runtime throw in the handler — it is not encoded in BulkMessageDto (all
  targeting fields @IsOptional, targetCriteria a bare @IsObject() unvalidated interface passthrough)
  nor in the hand-written FE client type (tenantIds? optional). The modal was written to the UI copy
  ('sent to all active tenants') against a client signature that compiles with no target at all, so
  nothing at build or test time could catch the drift. This is an instance of two systemic classes
  already established in this audit: (a) hand-written FE types drifting from BE DTOs with no
  contract gate, and (b) unvalidated interface-DTO (@IsObject() on a jsonb-bound interface bypasses
  whitelist validation inside the object — announcement.controller.ts has the identical defect),
  plus the page-wide swallowed-error/console.error pattern hiding the failure from the operator.
- **Fix design:** Tier 1 (make wrong payloads impossible) + Tier 3 (contract gate), fixed at the
  source on both sides. BACKEND: (1) New
  apps/admin-api-service/src/support/dto/announcement-target.dto.ts: AnnouncementTargetDto class
  containing ONLY the fields getTargetTenants actually interprets (plans, regions, tenantIds,
  excludeTenantIds, includeInactive), each fully decorated (@IsArray()+@IsString({each:true}),
  @IsBoolean()); wire into BulkMessageDto via @ValidateNested()+@Type(() => AnnouncementTargetDto) —
  whitelist/forbidNonWhitelisted now applies INSIDE the object, killing the unvalidated-interface
  passthrough and making uninterpreted criteria (modules, tenantStatuses) rejected instead of
  silently ignored. Apply the same DTO to announcement.controller.ts (pattern-level application of
  the systemic fix). (2) Add a class-level custom class-validator constraint on BulkMessageDto (e.g.
  @HasBulkTarget()) enforcing exactly-one-of: non-empty tenantIds XOR targetCriteria defined, with
  targetCriteria: {} being the explicit, documented 'all active tenants' form (semantics already
  implemented by getTargetTenants). Remove the handler's ad-hoc tenantIds.length===0 throw —
  ValidationPipe rejects target-less payloads with a descriptive message before the handler runs.
  (3) Type the response: sendBulkMessage returns {sent, failed, threadIds}. FRONTEND: (4)
  services/types/support.ts: add AnnouncementTarget and an XOR request type — BulkMessageRequest =
  {subject; content; sendEmail} & ({tenantIds: [string, ...string[]]; targetCriteria?: never} |
  {targetCriteria: AnnouncementTarget; tenantIds?: never}) — plus BulkMessageResult {sent; failed;
  threadIds}. (5) services/api/support.ts: sendBulkMessage(data: BulkMessageRequest) =>
  apiFetch<BulkMessageResult>(...); the old target-less payload becomes a compile error caught by
  npm run type-check. (6) MessagingPage.tsx: handleBulkMessage sends {subject, content, sendEmail,
  targetCriteria: {}} (matches the UI's 'all active tenants' promise); on rejection keep the modal
  open and pass the error into BulkMessageModal to render inline; on success close the modal and
  surface the sent/failed counts from the typed response instead of silence. No entity/migration
  change — the jsonb persistence shape (AnnouncementTarget) is untouched; the DTO narrows the API
  surface only.
- **Files to change:**
  - `apps/admin-api-service/src/support/dto/announcement-target.dto.ts`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts`
  - `apps/admin-api-service/src/support/controllers/announcement.controller.ts`
  - `apps/admin-api-service/src/support/__tests__/messaging-bulk-contract.spec.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/MessagingPage.spec.tsx`
- **Proof of fix:** New
  apps/admin-api-service/src/support/**tests**/messaging-bulk-contract.spec.ts: (a) DTO-level via
  plainToInstance+validate under whitelist:true/forbidNonWhitelisted:true —
  {subject,content,sendEmail} with no target FAILS validation with the HasBulkTarget message;
  {targetCriteria:{}} passes; tenantIds:[] alone fails; both tenantIds and targetCriteria together
  fails (XOR); unknown key inside targetCriteria (e.g. modules or garbage) is rejected; (b)
  controller unit test (London school, mocked MessagingService): valid {targetCriteria:{}} invokes
  getTargetTenants and sendBulkMessage and returns {sent,failed,threadIds}. New/extended
  web/modules/admin-panel/src/pages/**tests**/MessagingPage.spec.tsx: modal 'Send to All' calls
  supportApi.sendBulkMessage with targetCriteria defined; a rejected call keeps the modal open and
  renders the error; a resolved call closes it and shows sent/failed counts. npm run type-check
  gates the FE XOR type (the previous target-less payload no longer compiles). All run under nx
  affected --target=test.
- **Effort:** M

### APA-195 [HIGH] Thread summary field drift zeroes unread badges and hides closed state, enabling silent 400s on send

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** Backend ThreadSummary returns {unreadCount, isClosed}; the FE MessageThread type
  declares {unreadCountAdmin, status}. The page maps unreadCount: thread.unreadCountAdmin || 0
  (always 0 — real unreadCount is overwritten) and isClosed: thread.status === 'closed' (always
  false — thread.status doesn't exist). Result: unread badges never show, closed threads render as
  open with the message input enabled, and sending into a closed thread returns 400 'Cannot add
  message to closed thread' which is swallowed by console.error.
- **Evidence:**
  - `apps/admin-api-service/src/support/entities/support.entity.ts:523-533 (ThreadSummary: unreadCount, isClosed)`
  - `web/modules/admin-panel/src/services/types/support.ts:139-155 (MessageThread: unreadCountAdmin, status)`
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx:87-93 (mapping overwrites real fields)`
  - `apps/admin-api-service/src/support/services/messaging.service.ts:227-229 (closed-thread 400)`
- **Verification:** Attempted refutation failed at every link; the failure is concretely reachable
  on the routed page. (1) Route confirmed: web/modules/admin-panel/src/Module.tsx:151 routes
  'support/messaging' to the REST-based MessagingPage (the GraphQL hooks in hooks/useMessaging.ts
  are dead code — nothing imports useAdminThreads). (2) Wire shape confirmed:
  supportApi.getMessageThreads (services/api/support.ts:72-73) hits GET /support/messages/threads ->
  MessagingController.getAllThreads
  (apps/admin-api-service/src/support/controllers/messaging.controller.ts:96-109) ->
  MessagingService.getAllThreads returns ThreadSummary[] {unreadCount, isClosed, ...}
  (messaging.service.ts:155-171, entity interface support.entity.ts:523-533). ResponseInterceptor
  sees {data,total} and wraps into {success,data,meta:{total,page,limit,...}}
  (response.interceptor.ts:44-65); apiFetch sees meta.page and returns {data: ThreadSummary[],
  ...meta} (http-client.ts:342-349). So result.data at the page IS the backend ThreadSummary shape
  with unreadCount/isClosed. (3) Overwrite mechanics confirmed: MessagingPage.tsx:87-93 spreads
  ...thread FIRST then sets unreadCount: thread.unreadCountAdmin || 0 and isClosed: thread.status
  === 'closed'. Both fields are undefined at runtime (they exist only in the hand-written FE type
  services/types/support.ts:139-155), so the literal's later keys clobber the real backend
  unreadCount with 0 and real isClosed with false. (4) Consequences confirmed: badge at line 399
  (unreadCount > 0) never renders; input gating at line 573 (!selectedThread.isClosed) always
  renders the composer for closed threads and shows 'Close Thread' instead of 'Reopen' (line 452);
  sending hits POST threads/:id/messages -> addMessage throws BadRequestException('Cannot add
  message to closed thread') (messaging.service.ts:227-229); http-client throws 4xx without retry
  (http-client.ts:309-311) and handleSendMessage swallows it via console.error
  (MessagingPage.tsx:171-173) with no UI error state — the message silently fails. Additional
  discovery amplifying the finding: the drift's origin is an abandoned ADR-013 migration —
  useMessaging.ts states it 'Replaces the old REST-based hooks that called supportApi' and the FE
  MessageThread type exactly matches the auth-service GraphQL contract
  (apps/auth-service/src/modules/messaging/entities/message-thread.entity.ts:
  status/unreadCountAdmin), while tenant-admin already writes threads via that GraphQL subgraph
  (web/modules/tenant-admin/src/graphql/communication-queries.ts:
  mySupportThreads/createSupportThread/sendSupportMessage). The admin REST page therefore reads a
  DIFFERENT store (admin.message_threads) than the one tenants write to (auth-service) —
  split-brain. Severity stays HIGH as filed: routed core support workflow with unread triage
  entirely dead, closed state hidden, and silent send failures; not CRITICAL (no
  security/data-loss/cross-tenant exposure).
- **Root cause:** The FE->BE contract link broke via an abandoned mid-migration. ADR-013 moved
  admin<->tenant support messaging to the auth-service GraphQL subgraph; the admin-panel's
  hand-written MessageThread type (web/modules/admin-panel/src/services/types/support.ts:139-155)
  was rewritten to the GraphQL wire shape (status: ThreadStatus, unreadCountAdmin/unreadCountTenant)
  and a complete replacement hook layer was added (hooks/useMessaging.ts: 'Replaces the old
  REST-based hooks that called supportApi'), but the routed MessagingPage was never switched over —
  it still calls REST supportApi.getMessageThreads against admin-api-service, whose actual wire
  shape is ThreadSummary {unreadCount, isClosed}. Because apiFetch<T> returns an unchecked assertion
  (return json as T, http-client.ts:348-351), the compiler binds the page to the phantom GraphQL
  shape and cannot detect that thread.unreadCountAdmin / thread.status do not exist at runtime; the
  page's spread-then-overwrite adapter (MessagingPage.tsx:87-93) then destroys the real values.
  Systemic class: FE-type drift — hand-written types in services/types/\* asserted onto apiFetch<T>
  with zero build- or test-time verification against the backend DTO. Compounded here by a
  dual-backend split-brain: tenant-admin writes support threads to the auth-service store via
  GraphQL, while the SUPER_ADMIN page reads/writes the orphaned admin-api-service
  admin.message_threads store, so beyond cosmetic drift the two sides of the conversation do not
  even share a database.
- **Fix design:** Tier-1 fix: complete the abandoned migration so the wrong shape becomes impossible
  and the split-brain disappears — bind the admin MessagingPage to the same auth-service GraphQL
  messaging contract the tenant side already uses, with codegen-generated types instead of
  hand-written ones. (1) Rewrite web/modules/admin-panel/src/pages/MessagingPage.tsx to consume the
  existing hooks in hooks/useMessaging.ts (useAdminThreads, thread messages, send,
  close/reopen/archive, stats). Delete the page-local ThreadSummary adapter interface and the
  field-remapping block (lines 37-43, 87-93) entirely — the hook's ThreadSummary (unreadCount,
  status) IS the wire shape, so no mapping layer exists to drift; render closed state from status
  === 'closed'. Surface mutation failures (send/close/reopen/archive/create/bulk) into component
  error state rendered in the UI instead of the banned console.error swallow. (2) Replace the
  hand-written GraphQL response interfaces in useMessaging.ts and graphql/messaging-operations.ts
  with types generated by the existing `npm run codegen` pipeline from the auth-service subgraph
  schema — the schema SSoT then enforces the shape at compile time (pattern-level cure for this
  FE-type-drift instance). (3) Bulk messaging has no GraphQL equivalent, and today's REST
  /support/messages/bulk writes to the orphan store tenants never read — add a
  sendBulkSupportMessage mutation to apps/auth-service/src/modules/messaging (resolver + service
  method reusing createThread per target tenant), and point BulkMessageModal at it. (4) Delete the
  now-dead REST path at the source so the split-brain cannot resurrect: remove the messaging
  functions and deprecated aliases from web/modules/admin-panel/src/services/api/support.ts and the
  drifted REST binding of MessageThread in services/types/support.ts; delete
  apps/admin-api-service/src/support/controllers/messaging.controller.ts and
  services/messaging.service.ts; remove the MessageThread/Message entities and ThreadSummary
  interface from support.entity.ts; unregister them in support.module.ts; add a new migration
  dropping admin.message_threads/admin.messages (preceded by a one-time data check/backfill into the
  auth-service store if production rows exist — blue-green rule: verify-empty or migrate, never
  silently drop data). (5) Tier-3 guard: new invariant spec
  tests/invariants/admin-messaging-single-backend.spec.ts asserting admin-api-service registers no
  support/messages routes and admin-panel source contains no REST messaging client, so the
  dual-backend pattern is detectable at test time if reintroduced.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx`
  - `web/modules/admin-panel/src/hooks/useMessaging.ts`
  - `web/modules/admin-panel/src/graphql/messaging-operations.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `apps/auth-service/src/modules/messaging/resolvers/messaging.resolver.ts`
  - `apps/auth-service/src/modules/messaging/services/messaging.service.ts`
  - `apps/auth-service/src/modules/messaging/__tests__/messaging.service.spec.ts`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts`
  - `apps/admin-api-service/src/support/services/messaging.service.ts`
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `apps/admin-api-service/src/support/support.module.ts`
  - `apps/admin-api-service/src/migrations/1800000000001-DropOrphanAdminMessagingTables.ts`
  - `web/modules/admin-panel/src/pages/__tests__/MessagingPage.spec.tsx`
  - `tests/invariants/admin-messaging-single-backend.spec.ts`
- **Proof of fix:** New spec web/modules/admin-panel/src/pages/**tests**/MessagingPage.spec.tsx:
  with mocked GraphQL hooks returning a thread {unreadCount: 3, status: 'closed'}, assert (a) the
  '3' unread badge renders in the thread list, (b) the Closed pill renders, (c) the composer is
  absent and the Reopen action is shown, and (d) a rejected send mutation surfaces a visible error
  element (no console.error path). New invariant spec
  tests/invariants/admin-messaging-single-backend.spec.ts: asserts no 'support/messages' controller
  route exists in apps/admin-api-service and no REST messaging client remains in
  web/modules/admin-panel/src/services/api. Extend
  apps/auth-service/src/modules/messaging/**tests**/messaging.service.spec.ts for the new bulk-send
  path (per-tenant thread creation, partial-failure accounting, closed-thread rejection unchanged).
  Compile-time proof: `npm run codegen` + `npm run type-check` green with generated subgraph types
  replacing the hand-written GqlMessageThread/ThreadSummary — any future schema drift now fails the
  build. Full gate: nx affected --target=test and --target=lint green.
- **Effort:** L

### APA-196 [MEDIUM] Internal Note toggle is decorative: isInternal never sent, notes go out as public messages

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** handleSendMessage posts only {content, senderName: 'Admin'} regardless of the
  isInternalNote toggle; the backend AddMessageDto supports isInternal but defaults to false. An
  operator writing a confidential internal note actually creates a public tenant-visible message
  (increments unreadTenantCount). Confidentiality contract silently violated.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx:159-174 (payload omits isInternal)`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts:46-61 (AddMessageDto has isInternal)`
  - `apps/admin-api-service/src/support/services/messaging.service.ts:250-253 (public message bumps unreadTenantCount)`
- **Verification:** CONFIRMED mechanics: MessagingPage.tsx:163-166 sends only {content,
  senderName:'Admin'}; isInternalNote only styles the composer and is reset (line 168). Root
  evidence is one level deeper than cited: services/api/support.ts:78 types the payload as {content:
  string; senderName: string} — isInternal is structurally impossible to pass, so the toggle could
  never have worked. Backend confirmed: AddMessageDto.isInternal optional
  (messaging.controller.ts:54-56), service persists isInternal: data.isInternal || false and bumps
  unreadTenantCount for non-internal admin messages (messaging.service.ts:238,250-253). REFUTED in
  part — "tenant-visible" overstates current reachability: this REST path writes
  admin.message_threads/admin.messages (admin-api-service, all endpoints SUPER_ADMIN-guarded; no
  tenant-facing reader exists), while the actual tenant support UI
  (web/modules/tenant-admin/TenantMessagesPage → GraphQL mySupportThreads) reads a completely
  separate store, auth.message_threads/auth.messages in auth-service, with no bridge or sync. So no
  tenant can read the misfiled note today — because no tenant can read anything sent from this page
  (sibling dead-channel defect). The breach is latent-but-durable: rows are persisted with
  isInternal=false and pending tenant-unread counts, so the moment the store split is healed (the
  intended direction — admin-panel FE types AND a complete orphaned hooks/useMessaging.ts GraphQL
  layer already target the auth-service shape, whose resolver enforces internal notes correctly:
  ForbiddenException for non-SUPER_ADMIN at auth messaging.service.ts:243, tenant reads filter
  isInternal=false at :138), historical "internal" notes surface as public tenant messages. Real
  defect (decorative security control + misclassified persisted data), but with no reachable
  disclosure path in current wiring HIGH is over-graded → MEDIUM. Systemic class: hand-written FE
  payload-type drift combined with a half-finished REST→GraphQL migration (parallel duplicate
  implementations).
- **Root cause:** The FE→BE link broke at the hand-written API-fn contract:
  services/api/support.ts:78 sendSupportMessage's payload type omits isInternal, so the page (which
  had the toggle UI ready) could not transmit it and silently dropped it. This drift exists because
  the payload types are hand-maintained with no contract test against the backend DTO, and because a
  REST→GraphQL migration was left half-finished: the replacement layer
  (graphql/messaging-operations.ts + hooks/useMessaging.ts, which carries isInternal as a typed
  SupportSendMessageInput field against auth-service's resolver) was fully written but never mounted
  — Module.tsx:151 still routes to the legacy REST page, which additionally targets a dead store
  (admin.messages) that no tenant-facing code reads, duplicating the real support-messaging store
  (auth.messages).
- **Fix design:** Complete the already-designed migration instead of patching the legacy path (tier
  1: make the wrong behavior impossible; the fix is the same one that heals the sibling dead-store
  finding). (1) Rewrite MessagingPage.tsx onto the orphaned GraphQL hooks: useAdminThreads,
  useAdminThread, useAdminThreadMessages, useMessagingStats, useCreateThread,
  useCloseThread/useReopenThread/useArchiveThread, and useSendMessage with input {threadId, content,
  isInternal: isInternalNote} — SupportSendMessageInput! makes isInternal an explicit, typed,
  schema-validated field (auth-service SendMessageInput has @Field({defaultValue:false}) @IsBoolean
  isInternal). This simultaneously fixes the page's other latent shape drift (it reads
  thread.unreadCountAdmin/status which the REST ThreadSummary never returns). (2)
  Server-authoritative semantics come free from auth-service: only SUPER_ADMIN may set isInternal
  (ForbiddenException), tenant reads structurally exclude internal notes server-side, internal notes
  do not touch lastMessage or unreadCountTenant — the FE 'Admin' senderName hardcode and the
  explicit markAsRead call are deleted (resolver derives senderName from the authenticated user;
  getMessages marks read automatically; drop the useMarkAsRead noop placeholder). (3) Delete the
  legacy messaging fns from services/api/support.ts (getMessageThreads, getThread,
  getThreadMessages, createThread, sendSupportMessage, markAsRead, archiveThread, closeThread,
  reopenThread, sendBulkMessage, getUnreadCount, getMessagingStats) and the now-unused deprecated
  type aliases — removal makes reuse of the field-dropping path a compile error. (4) The now
  fully-orphaned admin-api-service messaging REST surface
  (MessagingController/MessagingService/admin.message_threads+admin.messages) is the sibling
  dead-channel finding: retire it under that finding's ID with its own migration; do not leave a
  SUPER_ADMIN-only writer to a store nobody reads. Pattern-level gate: page-level spec asserting the
  wire payload carries the toggle state, plus internal-note confidentiality assertions in the
  auth-service service spec, so any future regression of either side fails CI.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/hooks/useMessaging.ts`
  - `web/modules/admin-panel/src/pages/__tests__/MessagingPage.spec.tsx`
  - `apps/auth-service/src/modules/messaging/__tests__/messaging.service.spec.ts`
- **Proof of fix:** New spec web/modules/admin-panel/src/pages/**tests**/MessagingPage.spec.tsx
  (mirroring the existing tenant-admin TenantMessagesPage.spec.tsx pattern): mock the shared-ui
  graphql layer, render the page, toggle "Internal Note", send → assert ADMIN_SEND_MESSAGE was
  invoked with input.isInternal === true (and false when untoggled), and assert internal notes
  render with the internal styling from the isInternal field returned by the query. Extend
  apps/auth-service/src/modules/messaging/**tests**/messaging.service.spec.ts (if not already
  covered): sendMessage with isInternal=true by non-SUPER_ADMIN throws ForbiddenException;
  getMessages for a tenant_admin excludes isInternal rows; internal notes do not increment
  unreadCountTenant or overwrite lastMessage. Compile-time proof: removal of
  supportApi.sendSupportMessage makes any legacy call a type-check failure (npm run type-check).
- **Effort:** M

### APA-197 [MEDIUM] Admin messages misrendered as inbound: FE checks senderType 'super_admin' but backend stores 'admin'

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** Every message alignment/color/read-receipt branch tests message.senderType ===
  'super_admin', while the controller persists senderType 'admin'. All admin-sent messages therefore
  render left-aligned as if from the tenant, and read receipts never display. FE MessageSenderType
  ('super_admin'|'tenant_admin'|'system') has drifted from the entity union
  ('admin'|'tenant_admin'|'system').
- **Evidence:**
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx:495-504 (senderType === 'super_admin' branches)`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts:190-192 (senderType: 'admin')`
  - `apps/admin-api-service/src/support/entities/support.entity.ts:100-101 (entity union)`
  - `web/modules/admin-panel/src/services/types/support.ts:101 (FE union with 'super_admin')`
- **Verification:** Confirmed end-to-end with no refuting layer. Write path:
  messaging.controller.ts:192 and :139 plus messaging.service.ts:356 persist senderType 'admin'
  exclusively; entity union (support.entity.ts:101) is 'admin'|'tenant_admin'|'system', so
  'super_admin' can never exist in admin.messages. Read path: MessagingService.getMessages returns
  raw entities (repository.find, line 283); ResponseInterceptor only wraps {success,data}; FE
  apiFetch (services/api/support.ts:75) unwraps and MessagingPage.fetchMessages (line 117-118)
  setMessages(data) verbatim — grep confirms no 'admin'→'super_admin' mapping anywhere in
  admin-panel src or admin-api-service. Render: 7 sites in MessagingPage.tsx
  (495,501,514,519,538,546,556) compare against 'super_admin', which never matches, so every admin
  message renders left-aligned in tenant styling and the read-receipt block (556) is dead code.
  Route is live (Module.tsx:151 'support/messaging'). Downgraded HIGH→MEDIUM: impact is purely
  presentational — senderName is printed on every bubble (line 516) so attribution remains textually
  correct; no data-integrity, security, or blocked action. Additionally the read-receipt loss is
  overstated: admin-message status only becomes 'read' via markMessagesAsRead(threadId,'tenant'),
  and no admin-api-service controller exposes a tenant-side read path, so receipts would remain
  'sent' even with the correct literal.
- **Root cause:** The FE-type link of the chain broke:
  web/modules/admin-panel/src/services/types/support.ts:101 hand-authored MessageSenderType as
  'super_admin'|'tenant_admin'|'system' against the platform ROLE vocabulary instead of the wire
  vocabulary defined by the entity ('admin'|'tenant_admin'|'system' at support.entity.ts:101). The
  union exists as three unlinked hand-maintained copies (entity column type, service/controller
  literals, FE type) with no shared source and no compile- or test-time gate, so TypeScript could
  not see across the FE/BE boundary and the drift shipped silently. This is an instance of the
  systemic FE-type-drift class (hand-written admin-panel types vs backend entities); the same file
  also drifted MessageStatus (FE omits the entity's 'failed' member).
- **Fix design:** Pattern-level (Tier 1 — make the wrong literal impossible): single-source the
  support-messaging wire vocabulary in a dependency-free shared contracts module, following the
  @platform/event-contracts precedent: libs/admin-contracts/src/support/messaging.contract.ts
  exporting
  `export const MESSAGE_SENDER_TYPES = ['admin','tenant_admin','system'] as const; export type MessageSenderType = (typeof MESSAGE_SENDER_TYPES)[number];`
  plus `MESSAGE_STATUSES = ['sent','delivered','read','failed'] as const` and derived MessageStatus.
  Backend: type the entity column (`senderType!: MessageSenderType`, column stays varchar(50)), the
  MessagingService.createThread/addMessage signatures, and the controller call sites from this
  contract. FE: services/types/support.ts re-exports MessageSenderType/MessageStatus from the
  contract instead of redeclaring — after which `senderType === 'super_admin'` is a TS2367
  no-overlap COMPILE ERROR, structurally preventing recurrence. Local application (Tier 2 — correct
  behavior automatic): in MessagingPage.tsx collapse the 7 scattered comparisons into one predicate
  `isOutboundAdmin(m: SupportMessage): boolean => m.senderType === 'admin'` used by the alignment,
  bubble-color, name/time-color, attachment, and read-receipt branches, so sender-direction
  semantics live in exactly one place. Tier 3 backstop: invariant spec with type-level
  Expect<Equal<...>> assertions binding entity Message['senderType'], FE
  SupportMessage['senderType'], and the contract union (fails tsc if either side ever redeclares),
  plus a MessagingPage component test asserting an 'admin' message renders justify-end with the
  read-receipt block and a 'tenant_admin' message renders justify-start. No defensive mapping/shim
  on read — the DB value 'admin' is already correct; only the FE contract was wrong. Companion gap
  to file as a separate finding (not a reason to widen this fix): no tenant-side read endpoint
  exists in admin-api-service, so admin-message status never reaches 'read' and receipts stay at
  'sent' even post-fix.
- **Files to change:**
  - `libs/admin-contracts/src/support/messaging.contract.ts`
  - `libs/admin-contracts/src/index.ts`
  - `tsconfig.base.json`
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `apps/admin-api-service/src/support/services/messaging.service.ts`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx`
  - `tests/invariants/admin-support-contract.spec.ts`
  - `web/modules/admin-panel/src/pages/__tests__/MessagingPage.spec.tsx`
- **Proof of fix:** New tests/invariants/admin-support-contract.spec.ts: type-level Expect<Equal<>>
  assertions that entity Message['senderType'], FE SupportMessage['senderType'], and contract
  MessageSenderType are identical unions (and same for MessageStatus incl. 'failed') — drift on
  either side fails compilation of the spec. New
  web/modules/admin-panel/src/pages/**tests**/MessagingPage.spec.tsx: render a thread with one
  senderType:'admin' and one senderType:'tenant_admin' message; assert the admin message has
  justify-end + blue-bubble classes and shows the read-status element, the tenant message has
  justify-start and no read-status element. npm run type-check proves the old comparisons are
  impossible (TS2367 if anyone reintroduces 'super_admin').
- **Effort:** M

### APA-198 [MEDIUM] Thread list tenant name always 'Unknown Tenant'

- **Status:** DESIGNED (brief)
- **Symptom:** getAllThreads reads tenantName from thread.metadata.tenantName, but createThread
  never writes metadata (and no other code does), so every thread summary carries 'Unknown'. The
  operator cannot tell which tenant a conversation belongs to.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/messaging.service.ts:161 (metadata?.tenantName || 'Unknown')`
  - `apps/admin-api-service/src/support/services/messaging.service.ts:56-64 (createThread writes no metadata)`
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx:396-398 (renders tenantName || 'Unknown Tenant')`
- **Root cause:** tenantName was designed as a denormalized copy in thread.metadata that no writer
  ever populates: createThread (messaging.service.ts:56-64) writes no metadata, so getAllThreads:161
  always falls through to 'Unknown'. The authoritative name lives in auth.tenants, and
  MessagingService already injects the TenantReadOnly repository but never uses it here.
- **Fix design:** Tier 2 — resolve the name from the source of truth at read time so staleness is
  impossible. In getAllThreads, after loading the page of threads, batch-fetch tenant names in one
  query (tenantRepository.find({ where: { id: In(tenantIds) } })), build an id→name map, and
  populate ThreadSummary.tenantName from it (fallback only for genuinely deleted tenants). Delete
  the metadata.tenantName read entirely — no stored copy. Spec: messaging.service test seeds a
  tenant row and a thread and asserts the summary carries the auth.tenants name, plus the
  deleted-tenant fallback case.
- **Files to change:**
  - `apps/admin-api-service/src/support/services/messaging.service.ts`
  - `apps/admin-api-service/src/support/__tests__/messaging.service.spec.ts`
- **Effort:** S

### APA-199 [MEDIUM] New Conversation takes free-text Tenant ID: non-UUID input 500s, no tenant existence check

- **Status:** DESIGNED (brief)
- **Symptom:** NewThreadModal asks the operator to type a raw tenant ID; the DTO validates only
  IsString. admin.message_threads.tenantId is uuid, so any typo produces a Postgres invalid-uuid 500
  (swallowed by console.error), and a syntactically valid but nonexistent tenant UUID silently
  creates an orphan thread.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx:780-793 (free-text tenantId input)`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts:31-44 (CreateThreadDto IsString only)`
  - `apps/admin-api-service/src/support/entities/support.entity.ts:42-43 (tenantId uuid column)`
- **Root cause:** The create-thread boundary trusts free text: NewThreadModal
  (MessagingPage.tsx:786-793) takes a typed tenant ID, CreateThreadDto.tenantId is only @IsString()
  (messaging.controller.ts:32-33) while the column is uuid, so malformed input reaches Postgres as
  an invalid-uuid 500, and a well-formed but nonexistent UUID silently creates an orphan thread — an
  unvalidated interface-DTO instance.
- **Fix design:** Three layers, all at the source. (a) DTO: @IsUUID() on CreateThreadDto.tenantId —
  malformed input becomes a 400 at the boundary. (b) Service: createThread verifies the tenant
  exists via the already-injected TenantReadOnly repository and throws NotFoundException otherwise —
  orphan threads become impossible. (c) FE: replace the free-text input with a tenant selector
  (searchable select fed by the existing tenants list API), so the operator picks a real tenant by
  name — which also complements the tenantName fix (support|p1|i4); submit errors surface via the
  useAdminMutation/toast pattern from support|p0|i7. Spec: controller test rejects non-UUID with
  400; service test rejects unknown tenant; MessagingPage test asserts the picker submits a selected
  tenant id.
- **Files to change:**
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts`
  - `apps/admin-api-service/src/support/services/messaging.service.ts`
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx`
  - `apps/admin-api-service/src/support/__tests__/messaging.service.spec.ts`
- **Effort:** M

### APA-200 [LOW] New thread double-counts the first message as unread (unreadTenantCount = 2)

- **Status:** DESIGNED (brief)
- **Symptom:** createThread seeds unreadTenantCount 1 for an admin sender, then addMessage
  increments it again for the same initial message, so a fresh thread reports 2 unread tenant
  messages after one message.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/messaging.service.ts:57-73 (seed then addMessage)`
  - `apps/admin-api-service/src/support/services/messaging.service.ts:250-253 (increment)`
- **Root cause:** Unread-count ownership is split between two writers: createThread pre-seeds
  unreadTenantCount/unreadAdminCount to 1 for the initial sender (messaging.service.ts:61-62), then
  delegates the same initial message to addMessage, which increments the same counter again
  (250-255) — so a fresh thread reports 2 unread for one message (both directions affected).
- **Fix design:** Single-writer principle: addMessage is the only code allowed to mutate unread
  counters. createThread creates the thread with both counts 0 (drop the senderType-conditional
  seeding) and lets the delegated addMessage do the one increment. Spec: messaging.service test
  asserts a new admin-created thread has unreadTenantCount === 1 and unreadAdminCount === 0 after
  the initial message (and the mirror case for tenant_admin sender).
- **Files to change:**
  - `apps/admin-api-service/src/support/services/messaging.service.ts`
  - `apps/admin-api-service/src/support/__tests__/messaging.service.spec.ts`
- **Effort:** S

## AnnouncementsPage — `/admin/support/announcements` — verdict: **PARTIAL**

**Chain:** FE (pages/AnnouncementsPage.tsx) -> supportApi -> /api/support/announcements\* ->
admin-api AnnouncementController ('support/announcements') -> AnnouncementService ->
admin.announcements / admin.announcement_acknowledgments (Baseline.ts:79-87,243; schema 'admin'
declared). List, stats, create (global only), publish, cancel, delete all hit the real DB and work;
the scheduled-publish and expiry crons are real. But the deliverable is stillborn: tenants read
announcements from a DIFFERENT system — auth-service GraphQL (auth.announcements,
TenantAnnouncementsPage in tenant-admin) — and nothing bridges admin.announcements to it, so nothing
created on this page is ever displayed to a tenant. The view/acknowledge endpoints that would feed
viewCount/acknowledgmentCount are themselves SUPER_ADMIN-only admin-api routes no tenant can call,
so engagement stats are permanently zero. Targeted announcements cannot be created (no criteria UI
-> backend 400), and the Edit button opens the stats modal instead of an edit form.

**Endpoints exercised:** `GET /api/support/announcements`; `GET /api/support/announcements/stats`;
`POST /api/support/announcements`; `POST /api/support/announcements/:id/publish`;
`POST /api/support/announcements/:id/cancel`; `DELETE /api/support/announcements/:id`;
`GET /api/support/announcements/:id/acknowledgments`

**DB tables:** `admin.announcements`, `admin.announcement_acknowledgments`,
`auth.announcements (tenant-facing silo, never written by this page)`

### APA-201 [CRITICAL] Announcements are stored but never delivered: tenants read a different table in a different service

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** This page persists to admin.announcements via admin-api REST. The tenant-facing
  surface (web/modules/tenant-admin TenantAnnouncementsPage) fetches announcements via the
  federation gateway from auth-service GraphQL (myAnnouncements) backed by auth.announcements. There
  is no event, sync job, or bridge between the two (AnnouncementService publishes nothing to the
  event bus). Publishing here flips a status flag in a table nobody but this admin page reads — the
  product promise 'Broadcast messages to all tenants' is false. The correctly-wired GraphQL hooks
  exist in the admin-panel (hooks/useAnnouncements.ts targeting auth-service) but no page uses them.
- **Evidence:**
  - `apps/admin-api-service/src/support/entities/support.entity.ts:136 (@Entity 'announcements' schema 'admin')`
  - `apps/auth-service/src/modules/announcement/entities/announcement.entity.ts:86 (@Entity 'announcements' schema 'auth')`
  - `web/modules/tenant-admin/src/graphql/communication-queries.ts:292-293 (tenant reads myAnnouncements via GraphQL)`
  - `apps/admin-api-service/src/support/services/announcement.service.ts:1-487 (no event-bus/notification integration anywhere)`
  - `web/modules/admin-panel/src/hooks/useAnnouncements.ts:1-23 (GraphQL replacement hooks exist, unused by AnnouncementsPage)`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:33-39 (page imports REST supportApi)`
- **Verification:** Verified end-to-end. Write path: AnnouncementsPage (routed at Module.tsx:152) →
  REST supportApi (services/api/support.ts:94-111) → admin-api AnnouncementController
  ('support/announcements') → admin.announcements (Baseline.ts:79). Full read of
  apps/admin-api-service/src/support/services/announcement.service.ts confirms publishAnnouncement()
  only flips status and saves — no event bus, outbox, or notification integration. Read path:
  tenant-admin lib/api.ts:882-884 → myAnnouncements GraphQL → auth-service AnnouncementResolver →
  auth.announcements ({schema:'auth'}), a disjoint table. Refutation attempts all failed: repo-wide
  grep shows AnnouncementPublishedEvent has a subscriber (notification-service
  messaging-event.handler.ts:98) but ZERO publishers; no sync job or dual-write exists; admin-api
  tenant-facing endpoints (tenant/:tenantId/active) are unreachable by tenants (global
  PlatformAdminGuard = SUPER_ADMIN, no gateway proxy); shell MainLayout matches were nav links only.
  The replacement GraphQL hooks (useAnnouncements.ts, header: 'Replaces the old REST-based hooks
  that called supportApi') target auth-service correctly but are imported by no page, and two are
  silent no-op placeholders. A SUPER_ADMIN publishing a critical/maintenance broadcast gets visual
  success while no tenant ever receives it — silent total failure of the feature's core promise
  justifies CRITICAL despite no data-integrity/security impact.
- **Root cause:** The FE→BE link broke at the admin write path due to a half-finished store
  migration. The platform intentionally moved announcements to a unified SSoT in auth-service
  (auth.announcements with scope PLATFORM|TENANT, SuperAdminOnly createPlatformAnnouncement
  mutation, myAnnouncements tenant read path) and even landed the replacement admin-panel hooks
  layer — but the final rewire of AnnouncementsPage from legacy REST supportApi to those hooks never
  happened, and the legacy admin-api announcement vertical (controller/service/entities/tables) was
  never deleted. Two authoritative stores now coexist: admins write admin.announcements (which no
  tenant-facing surface reads), tenants read auth.announcements (which the admin page never writes).
  The drift stayed silent because nothing detects (a) a table written by one surface and read by
  none, (b) a duplicated table name across schemas for one logical concept, or (c) an event type
  (AnnouncementPublished) that notification-service subscribes to but no service publishes. This is
  an instance of two systemic classes flagged in the audit brief: 'config-table-nobody-reads'
  (write-only store) and FE-wired-to-legacy-API-after-backend-migration, compounded by
  subscriber-without-publisher dead wiring.
- **Fix design:** Complete the already-designed migration to the single SSoT (auth.announcements)
  and delete the duplicate store — no bridge/sync-job compat shim between the two tables (that would
  be a Tier-4 workaround preserving dual SSoTs). (1) FE: rewire AnnouncementsPage.tsx to the
  existing GraphQL hooks in hooks/useAnnouncements.ts
  (useAdminAnnouncements/useCreateAnnouncement/usePublishAnnouncement/useCancelAnnouncement/useDeleteAnnouncement/useAnnouncementStats),
  mapping UI to the GraphQL shape (scope, isActive). The two silent no-op placeholder hooks must not
  survive: add a real announcementAcknowledgments(id) query and an updateAnnouncement(id, input)
  mutation (draft/scheduled only) to auth-service AnnouncementResolver+AnnouncementService+DTOs,
  then implement useAnnouncementAcks/useUpdateAnnouncement against them. (2) Make 'publish' actually
  broadcast: auth-service AnnouncementService.publishAnnouncement (and its scheduled-publish
  transition) emits AnnouncementPublishedEvent via createBaseEvent() through the outbox — the
  notification-service handler at messaging-event.handler.ts:98 already subscribes, so push/email
  delivery becomes live instead of dead wiring. (3) BE deletion: remove the legacy vertical from
  admin-api-service — announcement.controller.ts, announcement.service.ts,
  Announcement+AnnouncementAcknowledgment entities in support.entity.ts, providers in
  support.module.ts — and add a migration that one-time-copies any existing admin.announcements rows
  into auth.announcements (scope='platform') then drops admin.announcements +
  admin.announcement_acknowledgments (blue-green: copy first, drop after). Delete the announcement
  fns from admin-panel services/api/support.ts and prune services/types/support.ts to the types the
  GraphQL hooks re-export. (4) Pattern-level gates (Tier 3, make it detectable): extend
  e2e/tests/integration/schema-invariants.spec.ts to assert the
  announcements/announcement_acknowledgments tables exist ONLY in the auth schema
  (duplicate-logical-table-across-schemas check); add
  tests/invariants/event-publisher-subscriber-parity.spec.ts asserting every eventType any service
  subscribes to has at least one createBaseEvent publisher in the repo — this catches the whole
  subscribed-but-never-published class, not just announcements.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`
  - `web/modules/admin-panel/src/hooks/useAnnouncements.ts`
  - `web/modules/admin-panel/src/graphql/messaging-operations.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `apps/auth-service/src/modules/announcement/resolvers/announcement.resolver.ts`
  - `apps/auth-service/src/modules/announcement/services/announcement.service.ts`
  - `apps/auth-service/src/modules/announcement/dto/announcement.dto.ts`
  - `apps/auth-service/src/modules/announcement/announcement.module.ts`
  - `apps/auth-service/src/modules/announcement/__tests__/announcement.service.spec.ts`
  - `apps/admin-api-service/src/support/support.module.ts`
  - `apps/admin-api-service/src/support/controllers/announcement.controller.ts`
  - `apps/admin-api-service/src/support/services/announcement.service.ts`
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `apps/admin-api-service/src/migrations/1800000000001-MigrateAnnouncementsToAuth.ts`
  - `e2e/tests/integration/schema-invariants.spec.ts`
  - `tests/invariants/event-publisher-subscriber-parity.spec.ts`
  - `e2e/tests/modules/tenant-admin/tenant-communication.spec.ts`
- **Proof of fix:** Primary proof: extend
  e2e/tests/modules/tenant-admin/tenant-communication.spec.ts with a round-trip spec — SUPER_ADMIN
  runs createPlatformAnnouncement + publishAnnouncement via the gateway, then a TenantAdmin's
  myAnnouncements returns that announcement with isActive=true (this directly proves the broken
  product promise now holds). Unit: extend
  apps/auth-service/src/modules/announcement/**tests**/announcement.service.spec.ts to assert
  publishAnnouncement writes an AnnouncementPublishedEvent (createBaseEvent shape) to the outbox.
  Invariants: extend e2e/tests/integration/schema-invariants.spec.ts to fail if
  announcements/announcement_acknowledgments exist in any schema other than auth (fails today,
  passes after the drop migration); new tests/invariants/event-publisher-subscriber-parity.spec.ts
  fails on any subscribed eventType with no publisher (fails today on AnnouncementPublished, passes
  after). Build gate: deleting the REST fns from services/api/support.ts makes any lingering
  supportApi announcement import in admin-panel a compile error (tsc --noEmit), structurally
  preventing regression to the dead store.
- **Effort:** L

### APA-202 [HIGH] View/acknowledgment tracking is dead: recording endpoints are SUPER_ADMIN-only, so counts stay 0 forever

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** POST :id/view and :id/acknowledge live on admin-api behind the global
  PlatformAdminGuard (SUPER_ADMIN); no tenant user or tenant-facing service can ever call them, and
  nothing else writes admin.announcement_acknowledgments. viewCount/acknowledgmentCount rendered in
  the list and stats modal are permanently 0 and the acknowledgment list always shows 'No activity
  yet'.
- **Evidence:**
  - `apps/admin-api-service/src/support/controllers/announcement.controller.ts:240-274 (view/acknowledge endpoints)`
  - `apps/admin-api-service/src/app.module.ts:283-290 (global APP_GUARD PlatformAdminGuard)`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:363-372 (renders viewCount/acknowledgmentCount)`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:745-771 (ack list / 'No activity yet')`
- **Verification:** CONFIRMED, and deeper than stated. Chain: AnnouncementsPage (routed at
  /admin/support/announcements, Module.tsx:152) reads exclusively via REST supportApi ->
  admin-api-service -> admin.announcements/admin.announcement_acknowledgments (Baseline.ts:84-87).
  The ONLY writers of those tables are AnnouncementService.recordView/recordAcknowledgment,
  reachable solely through POST /support/announcements/:id/view and /:id/acknowledge, both
  @PlatformAdminOnly() under the global APP_GUARD PlatformAdminGuard (app.module.ts:283-286) with no
  @Public() escape; repo-wide grep shows zero callers — admin-panel supportApi does not even define
  view/acknowledge functions, and no service-to-service caller exists. Refutation attempt via the
  parallel auth-service announcement module (apps/auth-service/src/modules/announcement/) fails: its
  tenant-reachable viewAnnouncement/acknowledgeAnnouncement GraphQL mutations (called by
  web/modules/tenant-admin) write auth.announcements/auth.announcement_acknowledgments — disjoint
  tables the admin panel never reads. Additionally,
  web/modules/admin-panel/src/hooks/useAnnouncements.ts is a complete GraphQL migration to the
  auth-service lane ("Replaces the old REST-based hooks") that NOTHING imports — dead code with a
  placeholder useAnnouncementAcks returning []. So counts stay 0 forever and GET :id/acknowledgments
  reads a table nobody writes ("No activity yet" always). Bonus severity driver: admin-panel-created
  announcements (admin.announcements) are never surfaced to any tenant — the lane is write-only end
  to end. HIGH is correct: compliance-relevant acknowledgment tracking silently reports zeros; not
  CRITICAL (no security breach/data loss/crash).
- **Root cause:** The who-writes link of the FE->BE->DB chain broke via parallel-subsystem drift.
  The original admin-api REST announcement lane (admin schema) had tenant-facing recording endpoints
  (:id/view, :id/acknowledge with client-supplied tenantId/userId), but the service-wide
  SUPER*ADMIN-only PlatformAdminGuard severed their intended callers. The tenant-admin architectural
  overhaul (docs/superpowers/plans/2026-03-23-tenant-admin-architectural-overhaul.md) then built a
  SECOND announcement subsystem in auth-service GraphQL (auth schema) with JWT-derived identity for
  view/ack, wired tenant-admin FE to it, and even authored the admin-panel replacement hooks
  (useAnnouncements.ts) — but the migration was never completed: AnnouncementsPage still consumes
  the orphaned admin-api lane, useAnnouncements.ts is unimported dead code, and its ack-list hook is
  a stub. Net result: tenants write auth.*, the admin panel reads admin.\_, and
  admin.announcement_acknowledgments has zero writers. This is an instance of the systemic class
  'parallel duplicate subsystem / FE reads a table nobody writes', compounded by 'abandoned
  mid-flight migration leaving dead code on both sides'.
- **Fix design:** Consolidate on the ONE announcement subsystem tenants can actually reach —
  auth-service GraphQL (auth.announcements) — and delete the orphaned admin-api lane at the source
  (tier 1: make the split impossible; no counter patching). (1) auth-service: add
  announcementAcknowledgments(id: ID!) query to AnnouncementResolver returning
  AnnouncementAcknowledgment[] (viewedAt DESC), gated @TenantAdminOrHigher with the same scope check
  as getAnnouncement (SUPER_ADMIN for platform scope, tenant admin only for own tenant), backed by a
  new AnnouncementService.getAcknowledgments(userId, announcementId) that reuses getAnnouncement for
  access control — this closes the one genuine feature gap that forced the FE placeholder. (2)
  admin-panel: complete the abandoned migration — rewire AnnouncementsPage.tsx to the existing hooks
  (useAdminAnnouncements, useAnnouncementStats, useCreateAnnouncement, usePublishAnnouncement,
  useCancelAnnouncement, useDeleteAnnouncement), replace the useAnnouncementAcks stub with a real
  query hook against the new resolver (add the operation to graphql/messaging-operations.ts), and
  delete the announcement section from services/api/support.ts plus the admin-api-shaped
  Announcement types from services/types/support.ts. Note the consolidation also removes a
  trust-anchor smell: admin-api's AcknowledgeDto trusted client-supplied tenantId/userId, while
  auth-service derives identity from the JWT per CLAUDE.md tenant-ID sourcing. (3)
  admin-api-service: delete AnnouncementController + AnnouncementService, remove the
  Announcement/AnnouncementAcknowledgment entities from support.entity.ts, unregister them in
  support.module.ts, and add a new migration dropping admin.announcement_acknowledgments then
  admin.announcements (safe drop — zero writers, no backfill needed); update
  apps/db-migrate/src/schema-registry.ts and delete the announcement route assertions in
  contract-validation.spec.ts (routes gone from both sides). (4) Pattern-level gate for the systemic
  class: extend apps/admin-api-service/src/**tests**/contract-validation.spec.ts to BIDIRECTIONAL
  coverage of the support surface — every supportApi function must resolve to a registered
  controller route AND every admin-api support route must have a mapped FE consumer — which would
  have flagged both the unreachable :id/view//:id/acknowledge endpoints and the never-called
  tenant/:tenantId/\* endpoints; plus a new e2e round-trip spec proving tenant ack writes reach
  admin reads (see verification).
- **Files to change:**
  - `apps/auth-service/src/modules/announcement/resolvers/announcement.resolver.ts`
  - `apps/auth-service/src/modules/announcement/services/announcement.service.ts`
  - `apps/auth-service/src/modules/announcement/__tests__/announcement.service.spec.ts`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`
  - `web/modules/admin-panel/src/hooks/useAnnouncements.ts`
  - `web/modules/admin-panel/src/graphql/messaging-operations.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `apps/admin-api-service/src/support/controllers/announcement.controller.ts`
  - `apps/admin-api-service/src/support/services/announcement.service.ts`
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `apps/admin-api-service/src/support/support.module.ts`
  - `apps/admin-api-service/src/migrations/ (new DropOrphanedAdminAnnouncements migration)`
  - `apps/db-migrate/src/schema-registry.ts`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`
  - `e2e/tests/integration/announcement-ack-roundtrip.spec.ts (new)`
- **Proof of fix:** New e2e/tests/integration/announcement-ack-roundtrip.spec.ts: SUPER_ADMIN
  creates+publishes a requiresAcknowledgment platform announcement via the GraphQL lane, a
  TENANT_ADMIN executes viewAnnouncement + acknowledgeAnnouncement, then the SUPER_ADMIN
  myAnnouncements/announcementStats queries and the new announcementAcknowledgments(id) query must
  show viewCount=1, acknowledgmentCount=1, and a non-empty ack list — proving the write path and the
  admin read path hit the same tables. Extend
  apps/admin-api-service/src/**tests**/contract-validation.spec.ts to bidirectional
  supportApi<->controller-route coverage (fails on any FE function without a backend route OR any
  support route without an FE consumer — the generic detector for this finding's class; it must fail
  if the deleted announcement routes/entities reappear). Extend
  apps/auth-service/src/modules/announcement/**tests**/announcement.service.spec.ts for
  getAcknowledgments access control (SUPER_ADMIN on platform scope; tenant admin denied
  cross-tenant). Existing e2e/tests/integration/schema-invariants.spec.ts must stay green after the
  admin.announcements/admin.announcement_acknowledgments drop migration.
- **Effort:** L

### APA-203 [HIGH] 'Targeted' announcements cannot be created: UI collects no targetCriteria, backend rejects with 400, error swallowed

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The form offers a 'Targeted' audience toggle that only sets isGlobal=false; there is
  no UI to pick tenants/plans/regions, so the payload has no targetCriteria and createAnnouncement
  throws BadRequestException 'Target criteria required for non-global announcements'.
  handleCreateAnnouncement only console.errors, so the modal stays open with zero feedback — the
  operator cannot tell why nothing was created.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:578-588 (Targeted toggle, no criteria form)`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:487-497 (handleSubmit payload lacks targetCriteria)`
  - `apps/admin-api-service/src/support/services/announcement.service.ts:56-59 (400 on non-global without criteria)`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:178-187 (catch -> console.error, modal not closed)`
- **Verification:** Verified end-to-end against current code. FE: Module.tsx:152 routes
  support/announcements to AnnouncementsPage; the 'Targeted' button (578-588) only sets
  isGlobal=false, the modal has no criteria UI, and handleSubmit (487-497) omits targetCriteria; the
  call site casts away type safety (line 180:
  `data as Parameters<typeof supportApi.createAnnouncement>[0]`). BE: SupportModule registered in
  app.module.ts:229; all sent fields are whitelisted on CreateAnnouncementDto so the
  whitelist+forbidNonWhitelisted pipe passes; controller's `isGlobal: dto.isGlobal ?? true` cannot
  rescue an explicit false; announcement.service.ts:57-59 throws BadRequestException('Target
  criteria required for non-global announcements'). Client: http-client.ts:297-311 throws on 4xx
  with the server message; handleCreateAnnouncement (178-187) catches and only console.errors, and
  setShowCreateModal(false) sits inside the try, so the modal stays open with zero feedback.
  Refutation attempts failed: the GraphQL hooks in hooks/useAnnouncements.ts ('replaces the old
  REST-based hooks') are exported but imported nowhere — no alternate create path. HIGH is correct:
  half the page's advertised capability (global VE hedefli duyurular) is completely non-functional
  with a fully silent failure, and the de-facto workaround is broadcasting globally to all tenants.
  Not CRITICAL — no data loss, security, or tenant-isolation impact.
- **Root cause:** The FE→BE create contract is hand-written and drifted at both ends of the
  isGlobal/targetCriteria pairing invariant. (a) The FE request type
  (`Omit<Announcement, 'id' | 'viewCount' | 'acknowledgedCount' | ...>` in
  services/api/support.ts:97) is not derived from the backend DTO — it even omits a nonexistent key
  ('acknowledgedCount' vs the type's actual 'acknowledgmentCount'), and the page then casts a
  Partial<Announcement> into it, so nothing at compile time expresses 'isGlobal=false requires
  targetCriteria'; the form shipped the Targeted toggle without the criteria-collection UI and no
  type forced the pairing. (b) The backend enforces the invariant only as a runtime service check
  (announcement.service.ts:57-59), not at the DTO/validation boundary, so the violation surfaces as
  a late 400. (c) The page's mutation handlers uniformly swallow errors into console.error
  (handleCreateAnnouncement, handlePublish, handleCancel, handleDelete), making the contract break
  invisible to the operator. This is an instance of two systemic classes: hand-written FE-type drift
  / unvalidated interface-DTO, and the swallowed-catch mutation-handler pattern.
- **Fix design:** Tier-1 (make the wrong payload impossible) + tier-3 (validation-boundary
  detection), applied at the pattern level. FE CONTRACT: in services/types/support.ts define a
  discriminated union
  `CreateAnnouncementRequest = (Base & { isGlobal: true; targetCriteria?: never }) | (Base & { isGlobal: false; targetCriteria: AnnouncementTarget })`
  (Base = title/content/type/publishAt?/expiresAt?/requiresAcknowledgment?). Change
  supportApi.createAnnouncement to accept this union (deleting the drifted `Omit<Announcement,...>`
  with its phantom 'acknowledgedCount' key), type AnnouncementFormModalProps.onSave and
  handleCreateAnnouncement with the same union, and delete the `as Parameters<...>[0]` cast — a
  targeted payload without criteria then fails compilation. FE UI: when isGlobal=false, render a
  tenant multi-select in AnnouncementFormModal populated via the existing tenantsApi.list/search
  (services/api/tenants.ts:39,78) building targetCriteria.tenantIds (+ optional excludeTenantIds);
  submit stays disabled until at least one tenant is selected (UI mirror of the invariant). Expose
  ONLY tenantIds/excludeTenantIds because matchesTargetCriteria (announcement.service.ts:257-275)
  enforces nothing else — plans/modules/regions stay out of the UI until backend matching exists
  (otherwise the UI promises targeting the backend silently ignores). FE ERROR SURFACING (systemic):
  make onSave async-aware — handleSubmit awaits onSave, and the modal renders the thrown
  ApiError.message inline on rejection (modal already stays open); replace the four swallowed
  console.error catches on the page with the page-level setError already used by fetchAnnouncements.
  BE CONTRACT: move the pairing invariant to the validation boundary — CreateAnnouncementDto gets a
  nested `AnnouncementTargetDto` (`@ValidateNested() @Type(() => AnnouncementTargetDto)`,
  `@IsArray()/@IsString({each:true})/@ArrayNotEmpty` on tenantIds where present) plus
  `@ValidateIf(o => o.isGlobal === false) @IsDefined()` on targetCriteria, and a custom class-level
  validator rejecting an empty criteria object, so `isGlobal:false` without effective criteria 400s
  with a structured field-level message before reaching the service; keep the service check as the
  domain invariant (same rule at a second layer, not a shim) and delete the controller's redundant
  hand-rolled `if (!dto.title...)` check (ValidationPipe's job). Apply the same DTO treatment to
  UpdateAnnouncementDto and add a resulting-state pairing check in updateAnnouncement (today
  Object.assign can flip a global announcement to isGlobal=false with null criteria — same defect
  class).
- **Files to change:**
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`
  - `apps/admin-api-service/src/support/controllers/announcement.controller.ts`
  - `apps/admin-api-service/src/support/services/announcement.service.ts`
  - `web/modules/admin-panel/src/pages/__tests__/AnnouncementsPage.spec.tsx`
  - `apps/admin-api-service/src/support/__tests__/announcement.dto.spec.ts`
- **Proof of fix:** New apps/admin-api-service/src/support/**tests**/announcement.dto.spec.ts drives
  CreateAnnouncementDto/UpdateAnnouncementDto through a ValidationPipe instance
  (whitelist+forbidNonWhitelisted, matching create-service-app config): isGlobal=false without
  targetCriteria -> 400; targetCriteria:{} -> 400; targetCriteria:{tenantIds:['t1']} -> passes;
  isGlobal=true + targetCriteria -> rejected/never. New
  web/modules/admin-panel/src/pages/**tests**/AnnouncementsPage.spec.tsx: (a) selecting Targeted
  renders the tenant selector and disables submit until a tenant is chosen; (b) targeted submit
  calls supportApi.createAnnouncement with targetCriteria.tenantIds; (c) a rejected
  createAnnouncement keeps the modal open AND renders the error message text (kills the
  silent-swallow regression). Compile-time gate: vitest expectTypeOf assertions in the same spec
  proving {isGlobal:false} without targetCriteria is not assignable to CreateAnnouncementRequest
  (npm run type-check enforces the union repo-wide since the cast is removed). Run nx affected
  --target=test and --target=lint green.
- **Effort:** M

### APA-204 [MEDIUM] Edit button on drafts opens the Stats modal; no edit path exists

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** The draft row's Edit3 button calls setSelectedAnnouncement, and selectedAnnouncement
  exclusively renders AnnouncementStatsModal — the edit-capable AnnouncementFormModal is only ever
  instantiated for create (its 'announcement' prop is never passed). supportApi.updateAnnouncement
  (PUT :id, which the backend supports for drafts) is never called from any page. Draft content
  cannot be corrected; the operator must delete and recreate.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:388-393 (Edit button -> setSelectedAnnouncement)`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:452-458 (selectedAnnouncement -> AnnouncementStatsModal)`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:444-450 (FormModal used only for create, no announcement prop)`
  - `web/modules/admin-panel/src/services/api/support.ts:99-100 (updateAnnouncement defined but unused)`
- **Verification:** Every cited claim reproduces in current code and no alternate path refutes it.
  (1) The page is reachable: Module.tsx:152 routes `support/announcements` to AnnouncementsPage. (2)
  The draft-row Edit3 button (AnnouncementsPage.tsx:388-393) calls setSelectedAnnouncement. (3)
  `selectedAnnouncement` has exactly one render consumer — AnnouncementStatsModal (lines 453-458) —
  so clicking Edit opens a modal titled "Announcement Statistics". (4) AnnouncementFormModal is
  rendered only under `showCreateModal` with no `announcement` prop (lines 445-450), leaving its
  edit branch (prop, prefill at 478-485, "Edit Announcement" header at 504) dead code. (5) Grep
  confirms supportApi.updateAnnouncement (support.ts:99-100) has zero call-sites; the only other
  update surface, useAnnouncements.ts useUpdateAnnouncement (lines 256-264), is an explicit no-op
  placeholder on a different (GraphQL) data path — so no edit path exists anywhere. (6) The backend
  genuinely supports the edit: PUT /support/announcements/:id (announcement.controller.ts:172-187)
  with UpdateAnnouncementDto, and announcement.service.ts:107-141 permits full updates for
  draft/scheduled (only 'published' is restricted to expiresAt). Severity lowered HIGH→MEDIUM: it is
  a real broken primary control (Edit opens the wrong modal) and a missing CRUD path, but there is a
  complete workaround (delete + recreate the unpublished draft), no data loss, no security exposure,
  and blast radius is one SUPER_ADMIN page. One latent trap noted for remediation:
  updateAnnouncement is typed `Partial<Announcement>`, which includes server-managed keys (id,
  status, viewCount, createdAt…) that the platform ValidationPipe (`forbidNonWhitelisted: true`)
  would reject with 400 if ever sent — the fix must not naively wire it as-is.
- **Root cause:** The FE page's modal state machine broke, not the API chain: the page encodes
  "which modal is open" in two overlapping slots (`showCreateModal: boolean` +
  `selectedAnnouncement: Announcement | null`), and `selectedAnnouncement` was implicitly bound to
  the Stats modal. The edit affordance was scaffolded UI-first (Edit3 button, edit-capable FormModal
  props, updateAnnouncement api fn mirroring the backend PUT) but the wiring was never completed,
  and nothing detects the drift: no test asserts that every exported services/api function has a
  consumer, and the stringly/implicit modal state let the Edit button route into the wrong modal
  without any compile-time or test-time signal. This is an instance of the systemic dead-affordance
  class (api fn defined but unconsumed, component prop supported but never passed) plus the
  FE-type-drift class (request payload typed as Partial<Entity> instead of mirroring the whitelist
  DTO).
- **Fix design:** Tier 1 (make wrong wiring impossible), local: replace the two overlapping state
  slots in AnnouncementsPage with one discriminated union —
  `type ModalState = { kind: 'create' } | { kind: 'edit'; announcement: Announcement } | { kind: 'stats'; announcement: Announcement } | null`
  — and render exactly one modal per kind. Edit3 sets `{kind:'edit', announcement}`; View Stats sets
  `{kind:'stats', announcement}`; Create sets `{kind:'create'}`. Render AnnouncementFormModal for
  both 'create' and 'edit' (passing `announcement` in the edit case — the component already supports
  prefill and the "Edit Announcement" header). Complete its prefill: initialize
  publishAt/expiresAt/scheduleType from the announcement (scheduleType='scheduled' iff publishAt is
  set) so editing a scheduled draft does not silently drop its schedule. onSave branches:
  kind==='edit' → supportApi.updateAnnouncement(modal.announcement.id, payload); else
  createAnnouncement; then refetch list + stats. Tier 1, contract level (systemic FE-type-drift
  fix): in services/types/support.ts add explicit request types mirroring the backend DTOs —
  `UpdateAnnouncementRequest` and `CreateAnnouncementRequest` with exactly the
  UpdateAnnouncementDto/CreateAnnouncementDto whitelist fields (title, content, type, isGlobal,
  targetCriteria, publishAt, expiresAt, requiresAcknowledgment) — and retype
  supportApi.updateAnnouncement/createAnnouncement and the FormModal's onSave to them. This makes
  sending server-managed fields (which forbidNonWhitelisted would 400) a compile error and removes
  the bogus `Omit<Announcement,... 'acknowledgedCount'>` referencing a non-existent key. Tier 3
  (make the class detectable): extend the existing static contract test
  apps/admin-api-service/src/**tests**/contract-validation.spec.ts — it already TS-parses
  services/api/\*.ts per exported function — with an orphaned-api-function assertion: every exported
  api function must have ≥1 call-site outside services/ (pages/hooks/components). Today
  updateAnnouncement fails it; the gate then covers the whole defined-but-never-wired class across
  the admin panel. Plus a page-level component test proving the user-visible behavior.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`
  - `web/modules/admin-panel/src/pages/__tests__/AnnouncementsPage.spec.tsx`
- **Proof of fix:** 1) New component spec
  web/modules/admin-panel/src/pages/**tests**/AnnouncementsPage.spec.tsx: with a mocked supportApi,
  clicking Edit on a draft row renders the form modal prefilled with the draft's
  title/content/type/schedule (asserting the "Edit Announcement" header, NOT "Announcement
  Statistics"), and submitting issues updateAnnouncement(id, payload) whose payload keys are exactly
  the UpdateAnnouncementDto whitelist; clicking View Stats on a published row renders the stats
  modal. 2) Extended apps/admin-api-service/src/**tests**/contract-validation.spec.ts: new
  orphaned-api-function assertion (every exported services/api/\*.ts function has a call-site
  outside services/) — red on current HEAD because updateAnnouncement is unconsumed, green after the
  fix; existing URL-match assertions keep proving PUT /support/announcements/:id exists on the
  backend. 3) tsc (npm run type-check) proves server-managed fields can no longer be sent:
  UpdateAnnouncementRequest rejects status/viewCount/id at compile time.
- **Effort:** M

### APA-205 [MEDIUM] Publish/cancel/delete failures are silent

- **Status:** DESIGNED (brief)
- **Symptom:** handlePublish/handleCancel/handleDelete catch and console.error only. Backend 400s
  (e.g. 'Announcement is already published', 'Cannot delete published announcement') produce no UI
  feedback; the list simply refreshes unchanged.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:148-176 (three silent catch blocks)`
  - `apps/admin-api-service/src/support/services/announcement.service.ts:149-151,163-165 (400 paths)`
- **Root cause:** Same systemic silent-mutation-failure class as support|p0|i7:
  handlePublish/handleCancel/handleDelete (AnnouncementsPage.tsx:148-176) swallow errors with
  console.error, so deliberate backend 400s ('Announcement is already published', 'Cannot delete
  published announcement. Cancel it instead.' — announcement.service.ts:149-165) never reach the
  operator; the list just refreshes unchanged.
- **Fix design:** Apply the shared useAdminMutation + shared-ui useToast/ToastContainer pattern
  (built in support|p0|i7) to the three handlers so backend error messages render as toasts with
  zero per-page catch code. Additionally make the invalid actions unreachable in the UI (tier 1
  locally): render Publish only for draft/scheduled, Cancel only for published/scheduled, Delete
  only for non-published — driven by announcement.status, mirroring the service's state machine.
  Spec: AnnouncementsPage test mocks a 400 from publishAnnouncement and asserts the toast shows the
  server message, and asserts Delete is not rendered for a published announcement.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`
  - `web/modules/admin-panel/src/hooks/useAdminMutation.ts`
  - `web/modules/admin-panel/src/pages/__tests__/AnnouncementsPage.spec.tsx`
- **Effort:** S

### APA-206 [LOW] FE AnnouncementType includes 'success' which the backend does not support

- **Status:** DESIGNED (brief)
- **Symptom:** types/support.ts adds 'success' to the union; the entity/DTO only know
  info|warning|critical|maintenance, and the page's icon/color switches have no 'success' branch
  (would render undefined className). Latent drift.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/support.ts:161 (union with 'success')`
  - `apps/admin-api-service/src/support/entities/support.entity.ts:24 (backend union)`
- **Root cause:** Instance of the systemic FE-type-drift class: the hand-written FE union
  (types/support.ts:161) adds 'success' which the backend AnnouncementType (support.entity.ts:24),
  DTOs, and the page's getTypeIcon/getTypeColor switches (AnnouncementsPage.tsx:110-126) do not know
  — a 'success' value would render undefined className and can never round-trip the API.
- **Fix design:** Align the FE union to the backend at the source: remove 'success' so both sides
  read 'info' | 'warning' | 'critical' | 'maintenance' (folds into the shared support-contract
  module from support|p0|i6 as the durable home for the union). Then make future drift a compile
  error (tier 3): convert getTypeIcon/getTypeColor to exhaustive Record<AnnouncementType, ...> maps
  (or add a never-typed exhaustiveness default) so adding a member on either side without the other
  fails npm run type-check. Verification: type-check plus the support-contract spec asserting the
  announcement type enum values accepted by the API equal the FE union.
- **Files to change:**
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`
  - `apps/admin-api-service/src/support/__tests__/support-contract.spec.ts`
- **Effort:** S

## OnboardingPage — `/admin/support/onboarding` — verdict: **PARTIAL**

**Chain:** FE (pages/OnboardingPage.tsx) -> supportApi -> /api/support/onboarding\* -> admin-api
OnboardingController ('support/onboarding') -> OnboardingService -> admin.onboarding_progress
(Baseline.ts:99; schema 'admin' declared). List/stats/mutations run real repository queries and the
page loads. But it does not track real tenant progress: rows exist only if someone manually POSTs
/initialize (nothing in tenant provisioning creates them — the provisioning workflow writes
admin.tenant_onboarding_acks, an unrelated table), and step completion is only mutable via API calls
the page never makes, so 'progress' reflects nothing the tenant actually did. Steps and training
resources are hardcoded arrays with dead URLs. Severe FE/BE field drift ('progress' vs
completionPercent, step.name vs title, stats.stalled vs skipped, lastActivityAt/assignedTo/notes
nonexistent) makes most of the rendered detail blank, 'undefined%', or NaN.

**Endpoints exercised:** `GET /api/support/onboarding`; `GET /api/support/onboarding/stats`;
`GET /api/support/onboarding/steps`; `GET /api/support/onboarding/resources/all`;
`POST /api/support/onboarding/initialize`; `POST /api/support/onboarding/:tenantId/skip`;
`POST /api/support/onboarding/:tenantId/assign-guide (defined in FE api, unused by page)`

**DB tables:** `admin.onboarding_progress`,
`admin.tenant_onboarding_acks (provisioning acks — NOT connected to onboarding_progress)`

### APA-207 [HIGH] Onboarding progress does not read real tenant activity and is never initialized automatically

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** admin.onboarding_progress rows are created only by POST
  /support/onboarding/initialize; tenant provisioning never calls it (the tenant module's onboarding
  handler writes admin.tenant_onboarding_acks for provisioning operations, a different table), and
  no event from farm/sensor/auth services feeds completeStep. In practice the list is empty for real
  tenants, and the 'Start Onboarding' button is only rendered for rows that already exist with
  status not_started — where initializeOnboarding just returns the existing row unchanged. The page
  audits a ledger nobody writes.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/onboarding.service.ts:212-238 (initialize is the only row creator; returns existing row as no-op)`
  - `apps/admin-api-service/src/tenant/handlers/tenant-onboarding-ack.handler.ts:37-49 (provisioning writes admin.tenant_onboarding_acks, not onboarding_progress)`
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx:482-495 (Start Onboarding only shown when a not_started row already exists)`
  - `apps/admin-api-service/src/support/services/onboarding.service.ts:293-338 (completeStep only callable via admin API; page has no complete-step UI)`
- **Verification:** Verified all four claims against current code. (1) admin.onboarding_progress has
  exactly one writer path: OnboardingService
  (apps/admin-api-service/src/support/services/onboarding.service.ts), whose row-creator
  initializeOnboarding (lines 212-238) is reachable only via POST /support/onboarding/initialize;
  repo-wide grep shows the only caller of that route is the admin-panel FE
  (web/modules/admin-panel/src/services/api/support.ts:119). (2) Tenant provisioning
  (tenant-provisioning-workflow.service.ts) reads/writes only admin.tenant_onboarding_acks (a
  provisioning ack barrier via TenantOnboardingAckHandler) and never imports OnboardingService —
  different table, different concept. (3) No event feeds completeStep: the only @EventPattern
  handlers in admin-api-service are the two ack handlers, and apps/admin-api-service/src/main.ts
  passes no natsTransport to bootstrapService, so createServiceApp
  (libs/backend-common/src/bootstrap/create-service-app.ts:730) never calls connectMicroservice —
  admin-api-service has NO live microservice transport (latent related defect: the ack handler
  itself is on dead wiring). (4) FE chicken-and-egg confirmed: OnboardingPage.tsx builds
  progressList from GET /support/onboarding (existing rows only); 'Start Onboarding' renders only
  for an existing not_started row (line 482) and calls initializeOnboarding, which returns the
  existing row unchanged (service lines 223-225) — a no-op with no status transition and no welcome
  email; the page has no UI to create a row for a rowless tenant and no complete-step UI
  (completeOnboardingStep api fn is unused). Corroboration that the ledger was never exercised with
  real data: FE types drifted invisibly (FE
  'progress'/'stalled'/'assignedTo'/'lastActivityAt'/step.name vs BE
  completionPercent/skipped/assignedGuideName/updatedAt/title). Net effect: for every real tenant
  the page shows an empty list and all-zero stats — the default reachable state. HIGH is correctly
  graded: an entire admin page is structurally non-functional and misleads support staff into
  believing no tenants need onboarding. This is an instance of the systemic 'ledger-nobody-writes'
  class (admin page audits state with no producer).
- **Root cause:** The producer link of the FE->BE->DB chain was never built. The support-module
  onboarding vertical was authored as a self-contained CRUD feature with an in-code step catalogue,
  on the assumption that 'something' would initialize rows at tenant creation and advance steps from
  real activity — but tenant provisioning solved its own differently-purposed 'onboarding' need with
  admin.tenant_onboarding_acks (name collision masked the gap), and admin-api-service was never
  wired to the NATS microservice transport at all (main.ts passes no natsTransport), so no domain
  event (FarmCreated, SensorRegistered, AlertRuleCreated, UserInvited — all of which already exist
  in libs/event-contracts) can ever reach a projector. The FE then completed the trap by rendering
  only rows the BE returns, making the only initialization endpoint unreachable for rowless tenants
  and a no-op for existing ones. Drift persisted because the empty ledger meant the page's own
  FE-type mismatches never surfaced — nobody ever saw real data on it.
- **Fix design:** Systemic class: ledger-nobody-writes. Fix at the pattern level: every step in the
  onboarding catalogue must declare its producer, and producers must be wired automatically — no
  manually-fed audit tables. Tier 2 (make correct behavior automatic): (a) Initialize at the
  tenant-creation source of truth — TenantProvisioningWorkflowService's post-ack success path calls
  OnboardingService.initializeOnboarding(tenantId, tenantName) (SupportModule already exports
  OnboardingService; import it into TenantManagementModule). initializeOnboarding is already
  idempotent, so retries are safe. Add a data-backfill migration inserting not_started rows for
  existing admin.tenants missing from admin.onboarding_progress. (b) Event-driven step projection —
  add natsTransport: { queue: 'admin-api-service' } in apps/admin-api-service/src/main.ts (this also
  puts the currently-dead TenantOnboardingAckHandler on a live transport — flag as related latent
  defect) and grant the needed events.\* subscribe permissions in infrastructure/nats/services.yaml,
  regenerating nats.conf per ADR-015. New OnboardingProgressProjector (support/handlers/, registered
  as controller) maps existing contracts to steps: FarmCreated->farm_setup,
  SensorRegistered->sensor_config, AlertRuleCreated->alert_rules, UserInvited->team_invite;
  'welcome' already completes via sendWelcomeEmail. Tier 1 (make wrong state impossible): extend the
  OnboardingStep type with producer: 'event' | 'admin' | 'manual' and drive the projector from an
  exhaustive Record<EventType, StepId> so a producer:'event' step without a mapping is a compile
  error; completionPercent derives only from steps that have a real producer. (c) Give 'Start
  Onboarding' real semantics — new POST /support/onboarding/:tenantId/start (service
  startOnboarding: status->in_progress, startedAt=now, triggers welcome email); FE button calls it
  instead of the idempotent initialize. (d) Align the FE contract with the entity as part of the
  same fix: TenantOnboarding/OnboardingStep/stats types must mirror the BE response
  (completionPercent, skipped, assignedGuideName, updatedAt, title) — the drift is inseparable from
  this finding because real rows will now render. Tier 3 (detectable): integration spec proving
  provisioning creates the row and published domain events advance completedSteps/completionPercent.
- **Files to change:**
  - `apps/admin-api-service/src/main.ts`
  - `apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts`
  - `apps/admin-api-service/src/tenant/tenant.module.ts`
  - `apps/admin-api-service/src/support/support.module.ts`
  - `apps/admin-api-service/src/support/handlers/onboarding-progress.projector.ts`
  - `apps/admin-api-service/src/support/services/onboarding.service.ts`
  - `apps/admin-api-service/src/support/controllers/onboarding.controller.ts`
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `apps/admin-api-service/src/migrations/1801300000000-BackfillOnboardingProgress.ts`
  - `infrastructure/nats/services.yaml`
  - `infrastructure/docker/nats/nats.conf`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx`
  - `apps/admin-api-service/src/__tests__/integration/onboarding-lifecycle.integration.spec.ts`
- **Proof of fix:** New
  apps/admin-api-service/src/**tests**/integration/onboarding-lifecycle.integration.spec.ts: (a)
  completing tenant provisioning creates an admin.onboarding_progress row with status not_started;
  (b) publishing FarmCreated / SensorRegistered / AlertRuleCreated / UserInvited over the NATS test
  harness advances completedSteps and completionPercent for that tenant; (c) POST
  /support/onboarding/:tenantId/start transitions not_started->in_progress and sets startedAt; (d)
  the backfill migration inserts rows for pre-existing tenants (assert count parity admin.tenants vs
  onboarding_progress). Compile-time gate: exhaustive Record<ProjectedEventType, StepId> in the
  projector makes an unmapped producer:'event' step a tsc error (npm run type-check). Extend
  e2e/tests/integration/nats-invariants.spec.ts expectations for the admin-api-service subscribe
  permissions added to infrastructure/nats/services.yaml (generated nats.conf sentinel block must
  match).
- **Effort:** L

### APA-208 [HIGH] Field drift blanks the core renders: 'undefined% complete', empty step names, dead Needs-Attention filter

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The page renders progress.progress but the backend entity field is completionPercent
  (so '% complete' text and the progress-bar width are undefined); step.name but the backend step
  field is title (step names render blank); progress.lastActivityAt, progress.assignedTo and
  progress.notes do not exist on the entity (backend has updatedAt, assignedGuide/assignedGuideName,
  no notes), so the Needs Attention toggle filters out every row (requires lastActivityAt), the
  guide is never shown, and the notes card never appears.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx:412-422 (progress.progress in text and bar width)`
  - `apps/admin-api-service/src/support/entities/support.entity.ts:396-397 (completionPercent)`
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx:536-537 (step.name)`
  - `apps/admin-api-service/src/support/services/onboarding.service.ts:22-92 (steps carry title, not name)`
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx:137-141 (Needs Attention requires lastActivityAt, never present)`
  - `apps/admin-api-service/src/support/entities/support.entity.ts:420-424 (assignedGuide/assignedGuideName, no notes/lastActivityAt)`
- **Verification:** Refutation attempted and failed. The chain is fully wired and reachable:
  SupportModule is registered (app.module.ts:229), OnboardingController returns raw
  OnboardingProgress entities with no mapper/response-DTO on any read path, ResponseInterceptor only
  wraps the envelope (lifts {data,total,page,limit} to meta, never renames item fields), and the FE
  http-client's meta.page unwrap returns {data,...meta}, so the page loads and renders drifted data.
  Verified field-by-field: (1) entity has completionPercent, FE renders progress.progress
  (OnboardingPage.tsx:413/421/468) — the '% complete' number is missing and the bar's
  width:'undefined%' is invalid CSS that is dropped, so the block div fills its parent and every
  tenant shows a 100% bar; (2) backend steps carry title (support.entity.ts:505-514,
  onboarding.service.ts ONBOARDING_STEPS), FE renders step.name (page:537) — blank; (3) no
  lastActivityAt exists anywhere on the wire (entity has updatedAt; backend's own
  getTenantsNeedingAttention uses updatedAt and a dedicated /needs-attention endpoint exists but the
  page never calls it), so the Needs Attention toggle (page:137-141) filters out every row; (4)
  assignedGuide/assignedGuideName vs FE assignedTo — guide chip never renders; (5) no notes column —
  notes card dead. Verification also found adjacent same-class drift the auditor missed: FE status
  enum 'stalled' vs backend 'skipped' (support.entity.ts:29) — dead filter option, undefined
  status-badge class for skipped rows, stats.stalled undefined making totalTenants NaN (page:272)
  despite the backend stats payload containing a correct total. Severity stays HIGH: the page's
  three core renders (progress %, step names, attention filter) are broken on a SUPER_ADMIN
  operational surface; not CRITICAL because there is no security or data-integrity impact.
- **Root cause:** The FE→BE link broke at the hand-written type layer:
  web/modules/admin-panel/src/services/types/support.ts declares TenantOnboarding/OnboardingStep
  shapes (progress, name, code, helpUrl, lastActivityAt, assignedTo, notes, status 'stalled') that
  were authored for the page's original mock data (the page header says 'Sprint 3 Fix: Mock data
  removed') and were never reconciled with the real backend contract when the API was wired in.
  Nothing could catch the drift because the backend has NO response contract at all —
  OnboardingController returns raw TypeORM entities, so the wire shape is implicitly 'whatever the
  entity serializes to' (completionPercent, title, updatedAt, assignedGuideName, 'skipped'), and the
  two TypeScript projects never share a type, so tsc passes on both sides while every field name
  disagrees. This is an instance of the systemic FE-type-drift class already established in this
  audit (hand-written services/types/\* vs entity-serialization wire truth).
- **Fix design:** Systemic-class fix (FE-type drift) at the pattern level plus local application,
  per the tier hierarchy. TIER 1 — make drift impossible by giving the onboarding wire contract a
  single source both sides compile against: create a shared contract module
  libs/admin-contracts/src/support/onboarding.ts (new small Nx lib, path-aliased in
  tsconfig.base.json; importable by both apps/admin-api-service and web/modules/admin-panel —
  backend-common cannot be used because the FE must not depend on it) exporting OnboardingStatus =
  'not_started'|'in_progress'|'completed'|'skipped', OnboardingStepDto
  {id,title,description,order,isRequired,estimatedMinutes,videoUrl?,resourceUrl?},
  OnboardingProgressDto
  {tenantId,tenantName,status,completionPercent,completedSteps,currentStep?,assignedGuide?,assignedGuideName?,welcomeEmailSent,startedAt?,completedAt?,createdAt,updatedAt}
  with ISO-string dates, and OnboardingStatsDto matching getOnboardingStats() (total, notStarted,
  inProgress, completed, skipped, avgCompletionPercent, avgCompletionDays, completionByStep).
  Backend: add an explicit entity→DTO mapper (toOnboardingProgressDto with Date.toISOString at the
  serialization boundary) and give every OnboardingController read method an explicit
  Promise<OnboardingProgressDto|...> return type; type ONBOARDING_STEPS as OnboardingStepDto[] and
  move the duplicate OnboardingStep interface out of support.entity.ts (the entity file keeps only
  persistence types). Any future entity rename now fails compilation in the controller, and any FE
  misuse fails npm run type-check. FE: services/types/support.ts deletes the fictional
  TenantOnboarding/OnboardingStep and re-exports the contract types; services/api/support.ts types
  getOnboardingStats/getTenantOnboardings/etc. against the contract. Local application in
  OnboardingPage.tsx: render completionPercent; render step.title; Needs Attention switches to the
  already-declared supportApi.getTenantsNeedingAttention() endpoint so the 30-day/in_progress rule
  lives in exactly one place (backend), instead of re-deriving it client-side from a field that does
  not exist; render assignedGuideName; delete the notes card (the field is fiction — adding a notes
  column to satisfy dead UI would be inventing product scope, not fixing the contract); replace
  'stalled' with 'skipped' in the status filter, OnboardingStatus union, getStatusColor, and the
  stats cards; compute Total Tenants from stats.total instead of summing (kills the NaN). No
  defensive ?., no shims — the wrong field names simply stop compiling. TIER 3 backstop for the
  class: a controller contract spec asserting the serialized JSON keys of each onboarding endpoint
  equal the contract DTO keys, so an entity change that bypasses the mapper is caught at test time.
- **Files to change:**
  - `libs/admin-contracts/src/support/onboarding.ts`
  - `libs/admin-contracts/src/index.ts`
  - `tsconfig.base.json`
  - `apps/admin-api-service/src/support/controllers/onboarding.controller.ts`
  - `apps/admin-api-service/src/support/services/onboarding.service.ts`
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx`
  - `apps/admin-api-service/src/support/__tests__/onboarding.controller.contract.spec.ts`
  - `web/modules/admin-panel/src/pages/__tests__/OnboardingPage.spec.tsx`
- **Proof of fix:** Add
  apps/admin-api-service/src/support/**tests**/onboarding.controller.contract.spec.ts: instantiate
  OnboardingController with a stubbed service returning a fully-populated OnboardingProgress entity,
  JSON-round-trip each read endpoint's result, and assert the exact key set equals Object.keys of an
  OnboardingProgressDto fixture (fails if anyone returns a raw entity again or renames a column
  without updating the mapper); same assertion for /steps (title present, name absent) and /stats
  (skipped present, stalled absent). Add
  web/modules/admin-panel/src/pages/**tests**/OnboardingPage.spec.tsx: render the page with mocked
  supportApi returning contract-typed fixtures and assert (a) the list shows '25% complete' and the
  bar width is '25%', (b) step titles from the fixture appear, (c) toggling Needs Attention calls
  supportApi.getTenantsNeedingAttention and shows exactly the rows that endpoint returns, (d) a
  'skipped' row gets a styled badge and Total Tenants renders stats.total (a number, never NaN).
  Structural gate: npm run type-check goes red if either side drifts from libs/admin-contracts,
  because both import the same types; nx affected --target=test covers both new specs.
- **Effort:** M

### APA-209 [HIGH] Stats header shows 'Total Tenants: NaN' — backend has no 'stalled' bucket

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** getOnboardingStats returns {total, notStarted, inProgress, completed, skipped,
  avgCompletionPercent, avgCompletionDays, completionByStep}. The FE expects and sums a 'stalled'
  field: totalTenants = notStarted + inProgress + completed + stats.stalled -> number + undefined =
  NaN, rendered directly. The Stalled tile renders empty and 'stalled' as a status filter matches
  nothing server-side (backend status enum is not_started|in_progress|completed|skipped).
- **Evidence:**
  - `apps/admin-api-service/src/support/services/onboarding.service.ts:559-568 (returned keys: skipped, no stalled)`
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx:272 (totalTenants sum includes stats.stalled)`
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx:310-313 (Stalled tile)`
  - `web/modules/admin-panel/src/services/api/support.ts:134-135 (FE declares stalled in stats type)`
  - `apps/admin-api-service/src/support/entities/support.entity.ts:29 (OnboardingStatus enum has skipped, not stalled)`
- **Verification:** Refutation attempts all failed. (1) Route shadowing: @Get('stats') is declared
  before @Get(':tenantId') in onboarding.controller.ts:110-125, so /support/onboarding/stats
  resolves correctly. (2) Controller reshaping: getStats() returns the service result verbatim; grep
  for 'stalled' across apps/admin-api-service yields zero hits (only 'installed'), so no layer
  injects the key. (3) Envelope handling: http-client.ts parseApiEnvelope returns envelope.data for
  non-paginated responses, so the raw service object {total, notStarted, inProgress, completed,
  skipped, avgCompletionPercent, avgCompletionDays, completionByStep} reaches setStats unmodified.
  (4) Type safety: apiFetch<T> is a blind cast; the FE-declared 'stalled: number'
  (services/api/support.ts:134-135) compiles clean against reality. Therefore OnboardingPage.tsx:272
  computes number + undefined = NaN, rendered in the 'Total Tenants' headline tile on every load;
  the Stalled tile (lines 310-313) renders undefined (empty). (5) Filter path: '?status=stalled'
  hits a bare unvalidated @Query('status') param (ValidationPipe only validates DTO classes), flows
  into where.status='stalled' in getAllProgress and matches zero rows since the persisted enum is
  not_started|in_progress|completed|skipped (support.entity.ts:29) — the admin is told no stalled
  tenants exist, which is silently misleading for the triage workflow. Severity HIGH stands: the
  SUPER_ADMIN onboarding-ops page shows a visibly broken KPI and its stuck-tenant triage filter is
  nonfunctional-but-plausible. Note the FE arithmetic is doubly wrong: even if a stalled count
  existed, stalled tenants are a subset of in_progress (per the backend's needs-attention
  definition), so the sum would double-count and omit skipped — the server-provided 'total' field is
  the only correct source. This is a confirmed instance of the systemic FE-type-drift class
  (hand-written services/types/\* + apiFetch<T> casts vs backend inline anonymous return shapes):
  TenantOnboarding.status also carries 'stalled'/omits 'skipped', and declares
  progress/lastActivityAt/assignedTo fields the backend never returns.
- **Root cause:** The FE→BE contract link broke at the type layer: OnboardingPage and the
  hand-written FE types were authored against a mock-era domain model (page header: 'Sprint 3 Fix...
  Mock data removed, real API integration') in which 'stalled' was a persisted fourth status. The
  backend's actual domain persists 'skipped' as the fourth status and models 'stalled' as a DERIVED
  condition (in_progress + 30 days inactive), exposed only via GET
  /support/onboarding/needs-attention and never surfaced in the stats payload. Nothing binds the
  FE's declared response types to the controller: apiFetch<T> is an unchecked cast, the backend
  returns inline anonymous shapes (no response DTO), and no shared contract module or contract spec
  covers the support domain — so the drift compiled clean on both sides and shipped. A second,
  compounding break: the FE re-derives 'total' by summing buckets client-side instead of consuming
  the server's existing 'total' field, which converted a missing key into NaN in the headline KPI
  and would have produced silently wrong arithmetic (double-counting stalled, omitting skipped) even
  if the key had existed.
- **Fix design:** Pattern-level (tier 1 — make drift a compile error) plus local application; this
  is an instance of the systemic FE-type-drift class, so fix the contract at the source once and
  consume it on both sides. PATTERN: make the existing-but-unused libs/shared-contracts
  (@aquaculture/shared-contracts, already aliased in tsconfig.base.json) the SSoT for admin API wire
  shapes. Add libs/shared-contracts/src/admin/onboarding.ts exporting: ONBOARDING_STATUSES =
  ['not_started','in_progress','completed','skipped'] as const with OnboardingStatus derived from
  it; OnboardingStatsDto {total; notStarted; inProgress; completed; skipped; stalled;
  avgCompletionPercent; avgCompletionDays; completionByStep: Record<string,number>};
  OnboardingProgressDto and OnboardingStepDto matching the backend's real shapes (title,
  completionPercent, updatedAt, assignedGuideName). Export from index.ts; wire the alias into
  web/modules/admin-panel tsconfig.json paths and vite.config.ts resolve.alias. BACKEND: (a)
  support.entity.ts types status from the contract OnboardingStatus so persisted enum and wire enum
  are one type; (b) onboarding.service.ts extracts a single isStalled(progress, now) predicate
  (named 30-day constant) used by BOTH getTenantsNeedingAttention() and getOnboardingStats() — one
  definition, cannot drift — and getOnboardingStats(): Promise<OnboardingStatsDto> adds stalled
  computed from that predicate ('stalled' is a real domain concept the stats endpoint failed to
  expose; it is an overlay of in_progress, not a fifth bucket, so total remains the sum of the four
  persisted statuses); (c) onboarding.controller.ts replaces the bare unvalidated @Query('status')
  with a query DTO using @IsOptional() @IsIn(ONBOARDING_STATUSES) so an unknown status is a 400
  instead of a silent empty result, and annotates getStats(): Promise<OnboardingStatsDto>. FRONTEND:
  services/types/support.ts deletes the drifted hand-written onboarding types and re-exports the
  contract types (import sites stay stable); services/api/support.ts types getOnboardingStats as
  apiFetch<OnboardingStatsDto> (inline literal at lines 134-135 deleted); OnboardingPage.tsx deletes
  its local OnboardingStats/OnboardingStatus, renders stats.total directly (client-side sum removed
  — server total is the SSoT), shows a six-tile grid (Total / Not Started / In Progress / Completed
  / Skipped / Stalled) with Stalled bound to the now-real stats.stalled, generates the status filter
  options by mapping ONBOARDING_STATUSES (new enum members appear automatically — tier 2), removes
  'stalled' from the filter (stalled is not a status; the stalled list view is the existing 'Needs
  Attention' toggle, rewired to call supportApi.getTenantsNeedingAttention() instead of client-side
  filtering on a nonexistent lastActivityAt field), and makes getStatusColor exhaustive over the
  contract union with a never-check so a future enum change fails type-check. The contract swap will
  surface this page's remaining field drift (progress→completionPercent, lastActivityAt→updatedAt,
  assignedTo→assignedGuideName, step.name→step.title) as compile errors — fixed in the same change,
  which is the intended tier-1 payoff. No migration needed: no persisted shape changes.
- **Files to change:**
  - `libs/shared-contracts/src/admin/onboarding.ts`
  - `libs/shared-contracts/src/index.ts`
  - `web/modules/admin-panel/tsconfig.json`
  - `web/modules/admin-panel/vite.config.ts`
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `apps/admin-api-service/src/support/services/onboarding.service.ts`
  - `apps/admin-api-service/src/support/controllers/onboarding.controller.ts`
  - `apps/admin-api-service/src/support/__tests__/onboarding-stats.contract.spec.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/OnboardingPage.stats.spec.tsx`
- **Proof of fix:** (1) NEW
  apps/admin-api-service/src/support/**tests**/onboarding-stats.contract.spec.ts (first spec in the
  support domain, following the existing
  apps/admin-api-service/src/tenant/**tests**/list-tenants-contract.spec.ts pattern): instantiate
  OnboardingService with a mocked OnboardingProgress repository over a fixture covering all four
  persisted statuses plus one stalled row (in_progress, updatedAt 31 days ago); assert (a) the
  resolved stats object's Object.keys().sort() exactly equals the key list of a
  `satisfies OnboardingStatsDto` fixture (no allowlist — any added/removed key fails), (b) total ===
  notStarted + inProgress + completed + skipped, (c) stalled === getTenantsNeedingAttention().length
  on the same fixture (shared-predicate agreement pin), (d) the list-endpoint query DTO rejects
  status='stalled' with a validation error via plainToInstance + validate. (2) Type gate: npm run
  type-check — after the contract swap, any FE reference to a key absent from OnboardingStatsDto
  (the exact defect here) or any backend return shape diverging from the annotated DTO is a compile
  error; this is the pattern-level regression gate for the FE-type-drift class. (3) NEW
  web/modules/admin-panel/src/pages/**tests**/OnboardingPage.stats.spec.tsx: render OnboardingPage
  with supportApi mocked to a contract-shaped stats fixture; assert the Total Tenants tile shows the
  fixture total, the Stalled tile shows the fixture stalled, and screen.queryByText(/NaN/) is null.
  Run via nx affected --target=test and nx affected --target=lint per repo law.
- **Effort:** M

### APA-210 [MEDIUM] Training resources and step tutorial links are hardcoded with dead URLs

- **Status:** DESIGNED (brief)
- **Symptom:** getTrainingResources returns a static in-code array whose urls (/videos/...,
  /docs/..., /webinars/...) and step videoUrls (/tutorials/...) point at routes that do not exist
  anywhere in the platform. The Resources tab presents fabricated content as clickable real material
  — MOCK_ONLY data inside an otherwise DB-backed page.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/onboarding.service.ts:109-190 (TRAINING_RESOURCES hardcoded)`
  - `apps/admin-api-service/src/support/services/onboarding.service.ts:54,63,72 (step videoUrl '/tutorials/...')`
  - `web/modules/admin-panel/src/pages/OnboardingPage.tsx:632-637 (renders resource.url as external link)`
- **Root cause:** Training content has no owner or persistence: TRAINING*RESOURCES
  (onboarding.service.ts:109-190) and ONBOARDING_STEPS videoUrls (:54,63,72,81,90) are fabricated
  compile-time constants whose URLs (/docs/*, /videos/_, /webinars/_, /tutorials/\_) resolve to no
  route in the shell or any backend. The FE (OnboardingPage.tsx:632-637) renders resource.url as a
  real anchor, presenting MOCK_ONLY data as clickable material inside an otherwise DB-backed page.
  Instance of the systemic 'fabricated in-code catalog nobody can edit or verify' class.
- **Fix design:** Make the catalog DB-backed and empty-by-default so fabricated content is
  structurally impossible (tier 1) and dead URLs are detectable (tier 3). (a) Add a TrainingResource
  @Entity (schema:'admin', table admin.training_resources) mirroring the existing TrainingResource
  interface, plus a new migration. (b) OnboardingService.getTrainingResources reads from the
  repository; add SUPER_ADMIN CRUD endpoints (POST/PUT/DELETE /support/onboarding/resources) with a
  class-validator DTO whose url field is @IsUrl-validated, so only operator-entered URLs can exist.
  (c) Delete the TRAINING_RESOURCES const and remove the dead videoUrl values from ONBOARDING_STEPS
  (field stays optional; FE empty-state at OnboardingPage.tsx:646-651 already handles zero
  resources). (d) Replace the inline anonymous FE type (services/api/support.ts:137-138) with a
  named TrainingResource type in services/types matching the entity. Verification: new
  apps/admin-api-service/src/support/**tests**/onboarding.controller.spec.ts asserting resources
  round-trip through the repository and CRUD DTO validation; extend it with a source-invariant
  assertion that no /videos/|/webinars/|/tutorials/ literals remain in support/ sources.
- **Files to change:**
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `apps/admin-api-service/src/support/services/onboarding.service.ts`
  - `apps/admin-api-service/src/support/controllers/onboarding.controller.ts`
  - `apps/admin-api-service/src/support/support.module.ts`
  - `apps/admin-api-service/src/migrations/<new>-AddTrainingResources.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `apps/admin-api-service/src/support/__tests__/onboarding.controller.spec.ts`
- **Effort:** M

### APA-211 [MEDIUM] sendWelcomeEmail returns fake success: no email is ever sent but welcomeEmailSent is persisted true

- **Status:** DESIGNED (brief)
- **Symptom:** The service logs, skips the commented-out TODO email integration, then marks
  welcomeEmailSent=true/welcomeEmailSentAt and the controller replies {success:true,
  message:'Welcome email sent'}. The database now permanently asserts an email was delivered that
  never existed. (Endpoint not wired into this page's UI, but it is the documented welcome-email
  path.)
- **Evidence:**
  - `apps/admin-api-service/src/support/services/onboarding.service.ts:383-409 (TODO email; flags set true anyway)`
  - `apps/admin-api-service/src/support/controllers/onboarding.controller.ts:165-181 (returns 'Welcome email sent')`
- **Root cause:** Side-effect stub with unconditional success persistence: sendWelcomeEmail
  (onboarding.service.ts:383-409) never dispatches anything (email integration is a commented-out
  TODO) yet persists welcomeEmailSent=true/welcomeEmailSentAt and completes the 'welcome' step; the
  controller (onboarding.controller.ts:165-181) returns 'Welcome email sent'. The DB permanently
  asserts a delivery that never occurred. The platform already owns the correct contract —
  NotificationSendEmailCommand (libs/event-contracts/src/notification-commands.ts) handled by
  notification-service — and admin-api-service already runs AdminOutboxModule/OutboxPublisher; this
  path simply never adopted it.
- **Fix design:** Wire the existing platform email contract instead of the stub (tier 2 — correct
  behavior becomes the default path). In sendWelcomeEmail, build a NotificationSendEmailCommand
  (source 'admin-api-service', deterministic requestReference 'admin-onboarding-welcome:<tenantId>'
  for idempotency, new templateId 'admin.onboarding_welcome.email', templateVariables
  {recipientName, tenantName, loginUrl}) following the established producer pattern in
  apps/hr-service/src/scheduling/services/schedule-notification.service.ts:349-382. Publish it via
  OutboxPublisher in the SAME transaction that sets welcomeEmailSent/welcomeEmailSentAt (import
  AdminOutboxModule into support.module.ts), so the flag truthfully means 'dispatch durably enqueued
  with at-least-once delivery' — on publish failure the transaction rolls back and no false success
  is ever recorded. Register the 'admin.onboarding_welcome.email' template in notification-service's
  email template handling (email.service.ts / notification-command.handler template resolution).
  Harden SendWelcomeEmailDto.recipientEmail with @IsEmail (contract fix at source). Controller
  message becomes 'Welcome email queued'. Verification:
  apps/admin-api-service/src/support/**tests**/onboarding.service.spec.ts asserting (1) outbox
  publish and flag update are atomic, (2) publish failure leaves welcomeEmailSent false, plus a
  notification-service handler spec for the new templateId.
- **Files to change:**
  - `apps/admin-api-service/src/support/services/onboarding.service.ts`
  - `apps/admin-api-service/src/support/controllers/onboarding.controller.ts`
  - `apps/admin-api-service/src/support/support.module.ts`
  - `apps/notification-service/src/notification/services/email.service.ts`
  - `apps/admin-api-service/src/support/__tests__/onboarding.service.spec.ts`
- **Effort:** M

### APA-212 [LOW] Skipping a required step throws a plain Error -> 500 instead of 400

- **Status:** DESIGNED (brief)
- **Symptom:** skipStep uses `throw new Error(...)` for the required-step guard, which the exception
  filter surfaces as a 500 rather than a BadRequestException 400.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/onboarding.service.ts:351-353`
- **Root cause:** The required-step guard in skipStep (onboarding.service.ts:352) throws an untyped
  `throw new Error('Cannot skip required step: ...')`, which Nest's exception layer maps to
  HTTP 500. It is a client-input violation and must be a 400. The same method already throws
  NotFoundException correctly two lines above — this is the single untyped throw in the support
  domain (grep-verified), so it is a local defect, not a systemic class.
- **Fix design:** Replace `throw new Error(...)` with `throw new BadRequestException(`Cannot skip
  required step: ${stepId}`)` (add BadRequestException to the existing @nestjs/common import at
  onboarding.service.ts:7), consistent with the service's established HTTP-exception usage.
  Verification: add a case to
  apps/admin-api-service/src/support/**tests**/onboarding.service.spec.ts asserting skipStep on a
  required step ('welcome', 'profile_setup', 'farm_setup') rejects with BadRequestException and that
  no OnboardingProgress mutation is persisted.
- **Files to change:**
  - `apps/admin-api-service/src/support/services/onboarding.service.ts`
  - `apps/admin-api-service/src/support/__tests__/onboarding.service.spec.ts`
- **Effort:** S

## Cross-cutting findings

### APA-213 [CRITICAL] Split-brain support architecture: admin panel and tenants operate on two disconnected persistence silos

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** Every support-tools domain exists twice. The SUPER_ADMIN pages (tickets, messaging,
  announcements) use admin-api REST persisting to the 'admin' schema (admin.support_tickets,
  admin.ticket_comments, admin.message_threads, admin.messages, admin.announcements,
  admin.announcement_acknowledgments). The tenant-facing product uses auth-service GraphQL
  persisting to the 'auth' schema (auth.support_tickets, auth.ticket_comments, auth.announcements,
  plus support-thread messaging), consumed by web/modules/tenant-admin (MyTickets, MySupportThreads,
  MyAnnouncements). No event, outbox, bridge, or sync connects them — neither support silo publishes
  anything to the event bus. Consequences: (1) tickets tenants create never appear in the admin
  TicketsPage; (2) admin replies/messages never reach any tenant user; (3) announcements published
  in the admin panel are never displayed to tenants; (4) engagement metrics (views/acks/unread) in
  the admin silo are structurally always zero. The admin support console is a sealed terrarium that
  manages only its own data.
- **Evidence:**
  - `apps/admin-api-service/src/support/entities/support.entity.ts:35,86,136,239,336 (all admin-schema tables)`
  - `apps/auth-service/src/modules/support/entities/support-ticket.entity.ts:71 (@Entity 'support_tickets' schema 'auth')`
  - `apps/auth-service/src/modules/support/entities/ticket-comment.entity.ts:52 (schema 'auth')`
  - `apps/auth-service/src/modules/announcement/entities/announcement.entity.ts:86 (schema 'auth')`
  - `web/modules/tenant-admin/src/graphql/communication-queries.ts:16,151,203,292 (tenant reads MySupportThreads/MyTickets/TicketComments/MyAnnouncements via GraphQL)`
  - `apps/admin-api-service/src/support/services/messaging.service.ts:1-30 and announcement.service.ts:1-33 (no EventBus/notification imports anywhere in the support module)`
- **Verification:** Adversarial verification confirmed every element and found the failure is even
  more clearly real than claimed. Admin side: TicketsPage/AnnouncementsPage/MessagingPage all import
  supportApi (REST /support/_) -> admin-api-service support module -> admin._ tables (entities
  support.entity.ts:35,86,136,201,239,336; tables created in
  migrations/1800000000000-Baseline.ts:72-95); grep across the module for
  EventBus/outbox/nats/HttpService/SignedHttpClient/axios returns zero hits, and every route sits
  behind the global SUPER_ADMIN PlatformAdminGuard, so tenants can never write into it — its
  senderType 'tenant_admin' and unreadTenantCount fields are structurally unreachable. Tenant side:
  TenantSupportPage -> useSupportTickets (useTenantData.ts:426) -> getMyTickets (lib/api.ts:816) ->
  MY_TICKETS_QUERY GraphQL -> auth-service SupportResolver -> auth.support_tickets (auth modules
  wired at app.module.ts:269-271); zero event publishing there either. Decisive evidence the auditor
  missed: admin-panel already contains a COMPLETED-BUT-NEVER-WIRED migration to the unified system —
  hooks/useMessaging.ts, hooks/useAnnouncements.ts, graphql/messaging-operations.ts (1,141 lines,
  self-documented as 'Replaces the old REST-based hooks that called supportApi' and 'match the
  auth-service resolvers exactly') are imported by nothing; and the auth-service resolvers already
  carry the SUPER_ADMIN console capabilities (updateTicketStatus/assignTicket @SuperAdminOnly,
  myTickets returns ALL tickets for SUPER_ADMIN since support.service.ts:87 only filters for
  TENANT_ADMIN). All four consequences are concretely reachable: tenant tickets invisible to the
  admin console, admin replies/messages/announcements never reach tenants, admin engagement metrics
  permanently zero. CRITICAL is warranted: the platform's entire cross-actor support/communication
  workflow silently fails end-to-end while both UIs appear to work — tenants file SLA-tracked
  support requests into a queue no operator surface reads, and operators publish announcements no
  tenant will ever see.
- **Root cause:** The FE->BE binding of the admin panel is pointed at a legacy, self-contained silo.
  Historically the admin-api support module was built first as a SUPER_ADMIN-only REST feature
  persisting to the admin schema; the real cross-actor support/announcement/messaging domain was
  later built in auth-service GraphQL (auth schema) with role-scoped resolvers that already include
  the SUPER_ADMIN console operations — the intended unified SSoT, as proven by the dead admin-panel
  GraphQL hooks written 'to match the auth-service resolvers exactly' and to 'replace the old
  REST-based hooks that called supportApi'. That consolidation stalled mid-flight: the
  hooks/operations were authored but never imported by any page, and the ticket domain never got
  GraphQL operations at all. No sync/bridge exists because the intended fix was consolidation, not
  synchronization. The drift persisted undetected because nothing enforces single ownership of a
  business domain's tables across service schemas — the schema-invariant suite checks WHERE tables
  live per service, but not that a domain table (support_tickets, announcements, message_threads...)
  exists in exactly one schema platform-wide, and neither silo publishes events that would have
  exposed the missing consumer.
- **Fix design:** This is the systemic class "duplicate-domain-silo" (same business domain persisted
  in two service schemas with no contract linking them) — fix by CONSOLIDATION into the
  already-built unified system, not by adding a sync bridge (a bridge would be a Tier-4 compat shim;
  consolidation is Tier 1: the second silo ceases to exist, so divergence becomes impossible). The
  auth-service GraphQL modules are the designated SSoT — they already implement role-scoped
  visibility (SUPER*ADMIN sees all tickets, TENANT_ADMIN tenant-scoped at support.service.ts:87),
  SuperAdminOnly triage (updateTicketStatus, assignTicket, isInternal comments), and both platform
  and tenant announcement flows. Plan: (1) FINISH THE STALLED MIGRATION — wire MessagingPage to the
  existing dead useMessaging hooks and AnnouncementsPage to useAnnouncements (both already match
  auth-service resolvers exactly), export them from hooks/index.ts, delete the corresponding
  supportApi REST functions and FE types. (2) TICKETS — author the missing GraphQL operations
  (myTickets/ticket/ticketComments/supportStats/updateTicketStatus/assignTicket/addTicketComment) in
  a new graphql/ticket-operations.ts + useTickets hooks, rewire TicketsPage. Admin-only capabilities
  that exist solely in the admin-api silo (SLA config + breach cron, stats by category/priority,
  sla-risk list, team workload, bulk messaging) move into auth-service
  SupportResolver/AnnouncementResolver as @SuperAdminOnly() resolvers; add the missing SLA columns
  (slaResponseMinutes, slaResolutionMinutes, slaBreached, dueAt, tags) to auth.support_tickets via a
  new blue-green-safe auth migration (nullable -> backfill). (3) DROP THE DEAD SILO AT THE SOURCE —
  delete the admin-api ticket/messaging/announcement controllers+services+entities (keep
  OnboardingProgress: it is genuinely admin-internal, has no tenant counterpart, and is NOT part of
  the split-brain) and generate an admin-api migration that copies any real production rows from
  admin.support_tickets/ticket_comments/message_threads/messages/announcements/announcement_acknowledgments
  into the auth.* tables, then drops the admin.\_ tables (BREAKING CHANGE footer required). (4)
  CLOSE THE DELIVERY LOOP — auth-service announcement publish emits the already-contracted
  AnnouncementPublishedEvent (libs/event-contracts/src/messaging-events.ts, consumed by
  notification-service) via createBaseEvent(), and ticket comment/status transitions emit new flat
  support events added to libs/event-contracts so notification-service can dispatch email/push; this
  makes admin->tenant delivery automatic (Tier 2) instead of relying on tenants polling. (5)
  PATTERN-LEVEL GATE (Tier 3, prevents recurrence of the class) — add
  tests/invariants/domain-table-uniqueness.spec.ts loading every service's TypeORM entity metadata
  and asserting each domain table name (support_tickets, ticket_comments, announcements,
  announcement_acknowledgments, message_threads, messages) maps to exactly ONE owning schema
  platform-wide, and extend e2e/tests/integration/schema-invariants.spec.ts to assert the admin
  schema no longer contains the six support tables.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/TicketsPage.tsx`
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`
  - `web/modules/admin-panel/src/hooks/useMessaging.ts`
  - `web/modules/admin-panel/src/hooks/useAnnouncements.ts`
  - `web/modules/admin-panel/src/hooks/index.ts`
  - `web/modules/admin-panel/src/graphql/messaging-operations.ts`
  - `web/modules/admin-panel/src/graphql/ticket-operations.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `apps/auth-service/src/modules/support/resolvers/support.resolver.ts`
  - `apps/auth-service/src/modules/support/services/support.service.ts`
  - `apps/auth-service/src/modules/support/entities/support-ticket.entity.ts`
  - `apps/auth-service/src/modules/support/dto/support.dto.ts`
  - `apps/auth-service/src/modules/announcement/services (event publish wiring)`
  - `apps/auth-service/src/migrations/<new>-AddTicketSlaColumns.ts`
  - `apps/admin-api-service/src/support/support.module.ts`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts (delete)`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts (delete)`
  - `apps/admin-api-service/src/support/controllers/announcement.controller.ts (delete)`
  - `apps/admin-api-service/src/support/services/ticket.service.ts (delete)`
  - `apps/admin-api-service/src/support/services/messaging.service.ts (delete)`
  - `apps/admin-api-service/src/support/services/announcement.service.ts (delete)`
  - `apps/admin-api-service/src/support/entities/support.entity.ts (keep only OnboardingProgress)`
  - `apps/admin-api-service/src/migrations/<new>-MigrateAndDropAdminSupportSilo.ts`
  - `tests/invariants/domain-table-uniqueness.spec.ts`
  - `e2e/tests/integration/schema-invariants.spec.ts`
- **Proof of fix:** 1) New tests/invariants/domain-table-uniqueness.spec.ts: loads TypeORM entity
  metadata from all services and fails if any domain table name (support_tickets, ticket_comments,
  announcements, announcement_acknowledgments, message_threads, messages) is declared in more than
  one schema — this is the pattern-level gate that makes any future duplicate-domain-silo a
  build-time failure. 2) Extend e2e/tests/integration/schema-invariants.spec.ts: assert the admin
  schema contains none of the six support tables after the drop migration. 3) New e2e round-trip
  spec e2e/tests/integration/support-single-silo.spec.ts: createTicket as TENANT_ADMIN via GraphQL,
  then myTickets as SUPER_ADMIN returns it and updateTicketStatus as SUPER_ADMIN is visible to the
  tenant via ticketComments/ticket — proving both actors operate on one persistence path; same
  round-trip for announcement publish -> tenant myAnnouncements -> acknowledgeAnnouncement -> admin
  announcementStats non-zero. 4) Admin-panel page specs
  (web/modules/admin-panel/src/pages/**tests**/): TicketsPage/MessagingPage/AnnouncementsPage tests
  mock graphqlClient and assert the pages issue the auth-service operations and that no
  /support/tickets|messages|announcements REST call remains (removing the REST fns from support.ts
  makes any leftover import a compile error — Tier 1). 5) Event-contract test: auth-service
  announcement publish emits schema-valid AnnouncementPublishedEvent consumed by
  notification-service handler spec.
- **Effort:** L

### APA-214 [HIGH] Abandoned mid-migration: correct GraphQL hooks exist in admin-panel but no support page uses them

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** hooks/useAnnouncements.ts and hooks/useMessaging.ts are explicitly documented as
  'Replaces the old REST-based hooks that called supportApi' and talk to the auth-service silo (the
  one tenants actually see) via the federation gateway. No page imports them — all four support
  pages still import the REST supportApi. Worse, the new hooks contain silent placeholders:
  useUpdateAnnouncement.mutate is a no-op TODO and useAnnouncementAcks always returns an empty
  array, so even a future page switch would silently lose edit and acknowledgment-list
  functionality. This is a half-finished migration shipped as if complete.
- **Evidence:**
  - `web/modules/admin-panel/src/hooks/useAnnouncements.ts:1-9 ('Replaces the old REST-based hooks')`
  - `web/modules/admin-panel/src/hooks/useAnnouncements.ts:256-264 (useUpdateAnnouncement no-op TODO)`
  - `web/modules/admin-panel/src/hooks/useAnnouncements.ts:198-206 (useAnnouncementAcks hardcoded empty)`
  - `web/modules/admin-panel/src/hooks/useMessaging.ts:1-9 (same replacement claim)`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx:33-39, MessagingPage.tsx:26-31, TicketsPage.tsx:28-36 (all import REST supportApi)`
- **Verification:** Adversarial verification CONFIRMS the finding and strengthens it. (1) Dead code
  confirmed: grep across web/ shows no page imports any export of hooks/useAnnouncements.ts or
  hooks/useMessaging.ts; all four support pages (AnnouncementsPage, MessagingPage, TicketsPage,
  OnboardingPage) import REST supportApi (services/api/support.ts via adminApi.ts). (2) Placeholders
  confirmed plus one more: useUpdateAnnouncement.mutate is an empty async TODO, useAnnouncementAcks
  hardcodes [], and useMessaging.ts also ships a no-op useMarkAsRead (lines 293-307). (3) The
  underlying failure is concretely reachable: REST supportApi hits admin-api-service /support/\*
  whose entities live in schema 'admin' (admin.announcements, admin.message_threads, admin.messages
  — apps/admin-api-service/src/support/entities/support.entity.ts), while tenants read the
  auth-service silo via GraphQL (auth.announcements, auth.message_threads — TenantAnnouncementsPage
  uses myAnnouncements, TenantMessagesPage/TenantSupportPage use
  mySupportThreads/createSupportThread). Grep of the admin-api support module finds zero
  EventBus/Outbox/NATS usage — no sync bridge. So an admin announcement never reaches tenants, and a
  tenant support thread never appears in the admin Messaging page. (4) The migration is viable:
  every operation in graphql/messaging-operations.ts matches a real auth-service resolver
  (SuperAdminOnly/TenantAdminOrHigher guards, transport = shared-ui graphqlClient at /graphql,
  already proven by tenant-admin). Only updateAnnouncement, an acknowledgments-list query, and
  markThreadAsRead are genuinely missing on the backend — exactly what the silent no-ops hide. HIGH
  is the right grade: broken support workflow (admin blind to tenant threads; announcements
  undelivered) + shipped-as-complete placeholders, but no security/data-corruption dimension, so not
  CRITICAL.
- **Root cause:** The FE service-layer/transport link broke because two parallel backend silos exist
  for the same support domain and the admin-panel was never moved off the dead one. Admin-panel was
  originally built against admin-api-service's own REST support module writing admin.\* tables — a
  silo nothing tenant-facing ever reads. The tenant-visible support/announcement domain was later
  established in auth-service (GraphQL resolvers over auth.announcements / auth.message_threads),
  consumed by tenant-admin. A migration of admin-panel to that silo was started
  (messaging-operations.ts + two complete hook suites, self-documented as 'Replaces the old
  REST-based hooks') but abandoned mid-flight: no page was switched, and the three resolver gaps
  (updateAnnouncement, acknowledgments list, markAsRead) were papered over with silent no-op
  placeholder hooks instead of adding the missing resolvers — the exact 'partial fix shipped as
  complete' pattern CLAUDE.md bans. Drift persisted because nothing detects it: no build/test gate
  fails on exported-but-never-imported hook modules, on placeholder no-op bodies, or on two live
  write paths for one domain. This is an instance of two systemic classes flagged in the audit
  brief: 'FE calls a silo nobody reads' (config-table-nobody-reads variant) and 'abandoned
  mid-migration dead parallel data path'.
- **Fix design:** Complete the migration at the source in one change-set, then gate the class. LOCAL
  (tier 1-2): (a) Backend first — auth-service is the SSoT for the tenant-visible silo; add the
  three missing operations so no placeholder is needed: updateAnnouncement mutation (draft/scheduled
  only, mirroring existing service rules) in modules/announcement/{resolver,service,dto};
  announcementAcknowledgments(announcementId) query reading auth.announcement*acknowledgments
  (TenantAdminOrHigher, scoped like getAnnouncement); markThreadAsRead(threadId) mutation in
  modules/messaging/{resolver,service}. (b) FE hooks — add the three operations to
  graphql/messaging-operations.ts and replace all three placeholder hooks (useUpdateAnnouncement,
  useAnnouncementAcks, useMarkAsRead) with real useGraphQLMutation/useGraphQLQuery wiring; delete
  every noop/placeholder body. (c) FE pages — switch AnnouncementsPage.tsx and MessagingPage.tsx to
  the GraphQL hooks and delete the announcement + messaging sections from services/api/support.ts
  (and their re-export in adminApi.ts plus now-unused types), making the dead silo unreachable from
  the FE (tier 1: wrong behavior impossible). (d) Backend decommission — remove
  AnnouncementController/MessagingController + their services/entities from admin-api-service
  SupportModule and add a migration that backfills any existing
  admin.announcements/admin.message_threads/admin.messages/admin.announcement_acknowledgments rows
  into auth.* then drops the tables (blue-green: backfill migration first, drop in the follow-on
  migration within the same tracked plan). Two write paths for one domain must not survive.
  Tickets/Onboarding are the same systemic class (tenant-admin already has GraphQL ticket ops
  against auth-service) — open a tracked HIGH finding with owner+deadline for their migration rather
  than silently expanding scope. PATTERN (tier 3): new invariant spec
  tests/invariants/admin-panel-support-silo.spec.ts asserting (1) no file under
  web/modules/admin-panel/src imports announcement/messaging members of supportApi, (2) every
  exported hook in admin-panel src/hooks/\_.ts is imported by at least one non-test module
  (dead-export gate; equivalently enable ESLint import/no-unused-modules scoped to that dir), and
  (3) no hook body matches /placeholder|noop|TODO: Replace/i — making both 'abandoned migration' and
  'silent placeholder hook' detectable at CI time. Additionally validate messaging-operations.ts
  documents against the composed federation schema in npm run codegen so operation/resolver drift
  fails the build.
- **Files to change:**
  - `apps/auth-service/src/modules/announcement/resolvers/announcement.resolver.ts`
  - `apps/auth-service/src/modules/announcement/services/announcement.service.ts`
  - `apps/auth-service/src/modules/announcement/dto/announcement.dto.ts`
  - `apps/auth-service/src/modules/messaging/resolvers/messaging.resolver.ts`
  - `apps/auth-service/src/modules/messaging/services/messaging.service.ts`
  - `web/modules/admin-panel/src/graphql/messaging-operations.ts`
  - `web/modules/admin-panel/src/hooks/useAnnouncements.ts`
  - `web/modules/admin-panel/src/hooks/useMessaging.ts`
  - `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`
  - `web/modules/admin-panel/src/pages/MessagingPage.tsx`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/services/adminApi.ts`
  - `apps/admin-api-service/src/support/support.module.ts`
  - `apps/admin-api-service/src/support/controllers/announcement.controller.ts`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts`
  - `apps/admin-api-service/src/support/entities/support.entity.ts`
  - `apps/admin-api-service/src/migrations/ (new backfill + drop migration for admin.* support tables)`
  - `tests/invariants/admin-panel-support-silo.spec.ts`
- **Proof of fix:** New invariant spec tests/invariants/admin-panel-support-silo.spec.ts: (1) greps
  web/modules/admin-panel/src for any import of supportApi announcement/messaging members — must be
  zero; (2) dead-export gate: every exported symbol in
  web/modules/admin-panel/src/hooks/useAnnouncements.ts and useMessaging.ts is imported by at least
  one non-test module; (3) no hook body contains placeholder/noop/TODO markers. Backend: extend
  apps/auth-service/src/modules/announcement/**tests**/announcement.service.spec.ts
  (updateAnnouncement rules, acknowledgments list) and add resolver specs for markThreadAsRead. FE:
  page specs asserting AnnouncementsPage edit flow invokes the updateAnnouncement GraphQL mutation
  and MessagingPage thread list renders mySupportThreads data. Schema:
  e2e/tests/integration/schema-invariants.spec.ts updated so admin schema no longer contains the
  four support tables after the drop migration. All must pass under nx affected --target=test.
- **Effort:** L

### APA-215 [HIGH] Every outbound notification path in the support module is an unimplemented TODO that reports success

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** Ticket replies: TicketComment.emailSent exists but no code ever sends or sets it —
  addComment persists the comment and stops. Messaging: addMessage has 'TODO: Send email
  notification if configured' commented out; sendBulkMessage ignores request.sendEmail entirely
  ('TODO: Send email if request.sendEmail is true') yet returns {sent: N} counting DB inserts as
  deliveries. Onboarding: sendWelcomeEmail marks welcomeEmailSent=true without sending anything.
  notification-service is never invoked from this module. Operators are systematically told delivery
  happened when nothing left the database.
- **Evidence:**
  - `apps/admin-api-service/src/support/services/messaging.service.ts:260-262 (TODO email notification)`
  - `apps/admin-api-service/src/support/services/messaging.service.ts:362 (TODO sendEmail in bulk loop; 'sent' counter is DB-insert count)`
  - `apps/admin-api-service/src/support/services/onboarding.service.ts:392-405 (TODO email service; flags set true)`
  - `apps/admin-api-service/src/support/entities/support.entity.ts:365-366 (emailSent column never written by any service code)`
- **Verification:** Confirmed against current code, not just the audit citations. (1)
  messaging.service.ts:260-262 and :362 contain the exact TODOs; addMessage persists and returns,
  and sendBulkMessage's 'sent' counter increments on createThread DB success while dto.sendEmail
  (forwarded by messaging.controller.ts:237 from FE support.ts:88) is never read. (2)
  onboarding.service.ts:383-409 sets welcomeEmailSent=true/welcomeEmailSentAt with the email call
  commented out; onboarding.controller.ts:180 returns {success:true, message:'Welcome email sent'}.
  (3) Message.emailSent (support.entity.ts:122) and TicketComment.emailSent (:366) are written by no
  service code (repo-wide grep: entities + migrations only). (4) Refutation attempts failed: the
  support module publishes zero NATS events, so notification-service's MessagingEventHandler 'legacy
  admin' MessageSent/BulkThreadsCreated branches are dead code for this flow (not even in-app
  notifications fire); the platform email command bus (commands.notification.sendEmail, consumed by
  notification-command.handler.ts, published today only by hr-service) is never invoked from
  admin-api; and the NATS ACL SSoT (infrastructure/nats/services.yaml) gives the gateway_service
  account (shared by admin-api-service) no publish grant for that subject, so the gap is structural
  — uncommenting the TODO would be ACL-denied. Reachability end-to-end is confirmed via admin-panel
  FE support.ts. Severity HIGH is correct: not a security vuln (so not CRITICAL), but a systemic
  false-success failure — DB delivery flags and API responses assert deliveries that never happened,
  and since tenant-admins have no read path to admin.message_threads (global SUPER_ADMIN guard),
  bulk 'messages to tenants' are a complete communications black hole reported as 'sent: N'.
- **Root cause:** The BE→notification-service link of the chain was never built: the support module
  was scaffolded UI/DB-first with delivery-state columns (emailSent, welcomeEmailSent) and
  success-shaped responses stubbed in, and outbound dispatch was left as TODOs. Two structural gaps
  let it drift silently: (a) recipient resolution for tenant-targeted platform mail was never
  designed — the notification command bus's recipientRef grammar (userId via auth PII lookup,
  tenantContactRef limited to hr.employee|manager) has no way to address 'the admin contact of
  tenant X', which is exactly what every support flow needs, so the TODOs had no contract to call;
  (b) the NATS ACL SSoT never granted the gateway_service account (shared by admin-api-service)
  publish rights on commands.notification.sendEmail, and no test ties a delivery flag/response to an
  actual dispatch, so the no-op was undetectable. This is an instance of the systemic
  'unimplemented-TODO-reports-success' class: delivery state is asserted locally instead of being
  derived from the dispatcher's result.
- **Fix design:** Pattern-level principle (tier 1/2): delivery state must be DERIVED from
  NotificationSendResult, never asserted locally; one module-owned dispatch service is the only
  writer of \*Sent flags. Local application: (1) Extend the platform recipient contract at the
  source — in notification-command.handler.ts extend resolveTenantContactRef's grammar with an
  auth-owned owner, e.g. 'auth.tenant.adminContact.email:<tenantId>', resolved via signedFetch to a
  new auth-service internal endpoint (alongside the existing GET users/:userId/pii in
  internal-auth.controller.ts) that returns the tenant's admin contact email; add email templates
  'admin.support.message.email@1', 'admin.support.ticket_comment.email@1',
  'admin.support.bulk_message.email@1', 'admin.onboarding.welcome.email@1' to renderTemplate
  (generic bodies, no message content, consistent with the H-2 no-content-leak precedent). (2) New
  SupportNotificationService in apps/admin-api-service/src/support/services/ — sole owner of
  outbound dispatch, publishing NotificationSendEmailCommand on
  NOTIFICATION_COMMAND_SUBJECTS.SEND_EMAIL via request/reply exactly as hr-service
  schedule-notification.service.ts does (deliveryId uuid, requestReference
  'admin.support.<kind>:<entityId>' for idempotent replay, source 'admin-api-service'), and the ONLY
  writer of Message.emailSent / TicketComment.emailSent — set exclusively when
  NotificationSendResult.success===true. (3) Wire callers: messaging.service.addMessage
  (non-internal, admin/system sender), ticket.service.addComment (non-internal admin replies),
  sendBulkMessage, onboarding.sendWelcomeEmail. (4) Make false success impossible in the API shape:
  sendBulkMessage returns {threadsCreated, emailsSent, emailsFailed, failed, threadIds} — delete the
  ambiguous 'sent' field so FE cannot conflate DB inserts with deliveries; onboarding endpoint takes
  a recipient userId (raw email in commands is rejected by the handler's
  containsRawRecipientMaterial guard), returns the real dispatch outcome, and propagates failure
  instead of {success:true}; update admin-panel FE api fns + types to the new shapes in the same
  change. (5) NATS ACL SSoT: add commands.notification.sendEmail to the gateway_service publish list
  in infrastructure/nats/services.yaml and regenerate infrastructure/docker/nats/nats.conf via
  scripts/nats/generate-nats-conf.py in the same commit (ADR-014/015). (6) Detectability gate for
  the systemic class: extend the tenant-provisioning-ssot-style invariant so every service that
  writes a delivery flag has a granted publisher and a matching @MessagePattern consumer for the
  subject, and every renderTemplate key referenced by publishers exists.
- **Files to change:**
  - `apps/admin-api-service/src/support/services/support-notification.service.ts`
  - `apps/admin-api-service/src/support/support.module.ts`
  - `apps/admin-api-service/src/support/services/messaging.service.ts`
  - `apps/admin-api-service/src/support/services/ticket.service.ts`
  - `apps/admin-api-service/src/support/services/onboarding.service.ts`
  - `apps/admin-api-service/src/support/controllers/messaging.controller.ts`
  - `apps/admin-api-service/src/support/controllers/onboarding.controller.ts`
  - `apps/notification-service/src/notification/event-handlers/notification-command.handler.ts`
  - `apps/auth-service/src/modules/authentication/controllers/internal-auth.controller.ts`
  - `infrastructure/nats/services.yaml`
  - `infrastructure/docker/nats/nats.conf`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/services/types/support.ts`
  - `tests/invariants/tenant-provisioning-ssot.spec.ts`
- **Proof of fix:** Add
  apps/admin-api-service/src/support/**tests**/support-notification.service.spec.ts (London school):
  asserts (a) addMessage/addComment/sendBulkMessage/sendWelcomeEmail publish
  NotificationSendEmailCommand on NOTIFICATION_COMMAND_SUBJECTS.SEND_EMAIL with the exact contract
  shape; (b) emailSent/welcomeEmailSent are persisted true ONLY when the mocked
  NotificationSendResult.success===true and stay false on failure/timeout; (c) sendBulkMessage
  response distinguishes threadsCreated from emailsSent (the 'sent' field no longer exists); (d)
  internal messages/comments publish nothing. Add
  apps/notification-service/src/notification/event-handlers/**tests**/notification-command.handler.admin-templates.spec.ts
  for the four new template keys and the auth.tenant.adminContact tenantContactRef resolution
  (raw-email refs still rejected). Extend tests/invariants/tenant-provisioning-ssot.spec.ts so
  services.yaml grants commands.notification.sendEmail publish to gateway_service and the generated
  nats.conf matches (e2e/tests/integration/nats-invariants.spec.ts already gates conf regeneration).
  Green run of nx affected --target=test covering admin-api-service, notification-service,
  auth-service, admin-panel.
- **Effort:** L

### APA-216 [MEDIUM] Guard posture verified sound; schema/migration parity verified sound (no finding — audit confirmation)

- **Status:** DESIGNED (brief)
- **Symptom:** Positive verification for the record: all support controllers are protected by the
  global APP_GUARD PlatformAdminGuard (RS256 verifyAsync + issuer/audience + access-token-type
  enforcement, default-deny to SUPER_ADMIN even on undecorated handlers), so no unguarded admin
  endpoint exists in this section. All seven support entities correctly declare schema 'admin'
  (platform-level service per ADR-011), and every table/column used by the code exists in the active
  Baseline migration (archived pre-baseline migrations under src/migrations/.archive are excluded
  from the runner glob '[0-9]\*'). The remaining MEDIUM: TicketController/DTO validation gaps noted
  per-page (e.g. AddCommentDto.attachments is @IsArray with no nested validation, allowing arbitrary
  JSON into the jsonb attachments column via a SUPER_ADMIN token).
- **Evidence:**
  - `apps/admin-api-service/src/app.module.ts:277-290 (APP_GUARD registration)`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:108-179 (verification + default SUPER_ADMIN role check)`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:72-101,242-244 (all support tables + FKs)`
  - `apps/admin-api-service/src/app.module.ts:117 (migrations glob '[0-9]*' excludes .archive)`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts:117-120 (attachments @IsArray only)`
- **Root cause:** Audit confirmation stands as verified (global APP_GUARD PlatformAdminGuard
  default-deny; all seven support entities on schema 'admin'; Baseline migration parity; .archive
  excluded by the '[0-9]*' glob). The residual defect is real and is an instance of the systemic
  'unvalidated interface-DTO' class: AddCommentDto.attachments (ticket.controller.ts:117-119) is
  @IsArray-only and typed with the TypeScript *interface\* TicketAttachment
  (support.entity.ts:465-472) — class-validator cannot validate interfaces, and the whitelist
  ValidationPipe strips only top-level unknown props, so arbitrary nested JSON of any shape/size
  flows into the jsonb attachments column (support.entity.ts:362-363). Same class on @IsArray-only
  tags fields in CreateTicketDto (:63-64) and UpdateTicketDto (:89-90) lacking
  @IsString({each:true}).
- **Fix design:** Tier 1 locally + tier 3 for the pattern. Local: define class TicketAttachmentDto
  in ticket.controller.ts (@IsString id/fileName, @IsString mimeType, @IsInt @Min(0) @Max fileSize,
  @IsUrl url, @IsISO8601 uploadedAt — mirroring the TicketAttachment interface exactly) and change
  AddCommentDto.attachments to @IsOptional @IsArray @ArrayMaxSize(10) @ValidateNested({each:true})
  @Type(() => TicketAttachmentDto) attachments?: TicketAttachmentDto[]; add @IsString({each:true})
  @ArrayMaxSize to the tags fields. Pattern gate: add a new invariant spec
  apps/admin-api-service/src/**tests**/dto-nested-validation.spec.ts that reflects over every
  controller DTO via class-validator getMetadataStorage() and fails when a property carries
  @IsArray/@IsObject without either primitive each-validation or @ValidateNested+@Type metadata —
  making any future interface-typed jsonb-bound DTO field a test-time failure across the service,
  with no allowlist. Verification: that invariant spec (red on current AddCommentDto, green after
  fix) plus a controller e2e-style spec asserting a malformed attachment element is rejected 400.
- **Files to change:**
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts`
  - `apps/admin-api-service/src/__tests__/dto-nested-validation.spec.ts`
- **Effort:** M

## Finding registry anchors

Registry IDs (`docs/reviews/_registry/findings.jsonl`) tracking findings in this document:

- **ADMIN-CRITICAL-010** — APA-185 / APA-186: support ticket create + assign 22P02 500s (actor UUID
  sourced from the authenticated context).
- **ADMIN-HIGH-011** — feature-flag override auto-revert wrote the non-UUID literal `system` into
  `revertedBy` (uuid) → 22P02 (SYSTEM_ACTOR_ID at both callers).
- **ADMIN-MEDIUM-012** — support-module DTOs validated client uuid fields as `@IsString` → 22P02 500
  instead of a clean 400 (`@IsUUID`).
- **ADMIN-CRITICAL-021** — APA-201: announcements are stored but never delivered — admin wrote
  `admin.announcements` (no tenant reads it) while tenants read `auth.announcements` (the admin page
  never wrote it), and `AnnouncementPublished` had a subscriber but no publisher; consolidated onto
  the `auth.announcements` SSoT (FE rewired to the GraphQL hooks, publish emits
  `AnnouncementPublished` through the transactional outbox, migration copies-then-drops the admin
  tables) with a new `event-publisher-subscriber-parity` invariant gating the dead-wiring class.
- **ADMIN-CRITICAL-022** — APA-213: split-brain support silos (tickets/messaging/announcements
  duplicated across the admin and auth schemas with no linking contract). Announcements silo fully
  consolidated here (via ADMIN-CRITICAL-021) and the systemic parity gate landed; the tickets +
  messaging silos are the tracked remainder (owner: admin-panel remediation lane; deadline Phase 0/1
  boundary).
