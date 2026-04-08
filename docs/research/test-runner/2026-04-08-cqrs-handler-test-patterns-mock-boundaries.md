# Research: CQRS Command Handler Test Patterns and Mock Boundaries

**Topic:** Mock boundaries (DB, NATS, Redis) not internals, command handler contract testing, event emission verification, saga testing, snapshot anti-patterns
**Date:** 2026-04-08
**Agent:** test-runner

## Sources

- [NestJS Testing - docs.nestjs.com/fundamentals/testing](https://docs.nestjs.com/fundamentals/testing)
- [NestJS CQRS Module - docs.nestjs.com/recipes/cqrs](https://docs.nestjs.com/recipes/cqrs)
- [Martin Fowler: CQRS - martinfowler.com/bliki/CQRS.html](https://martinfowler.com/bliki/CQRS.html)
- [Martin Fowler: Mocks Aren't Stubs - martinfowler.com/articles/mocksArentStubs.html](https://martinfowler.com/articles/mocksArentStubs.html)
- [Martin Fowler: Test Double - martinfowler.com/bliki/TestDouble.html](https://martinfowler.com/bliki/TestDouble.html)
- [Martin Fowler: GivenWhenThen - martinfowler.com/bliki/GivenWhenThen.html](https://martinfowler.com/bliki/GivenWhenThen.html)
- [Kent C. Dodds: Testing Implementation Details - kentcdodds.com/blog/testing-implementation-details](https://kentcdodds.com/blog/testing-implementation-details)
- [Kent C. Dodds: How to Know What to Test - kentcdodds.com/blog/how-to-know-what-to-test](https://kentcdodds.com/blog/how-to-know-what-to-test)
- [Google Testing Blog: Testing on the Toilet: Don't Overuse Mocks - testing.googleblog.com/2013/05/testing-on-toilet-dont-overuse-mocks.html](https://testing.googleblog.com/2013/05/testing-on-toilet-dont-overuse-mocks.html)
- [Google Testing Blog: Effective Snapshot Testing - testing.googleblog.com](https://testing.googleblog.com/)
- [Jest Snapshot Testing - jestjs.io/docs/snapshot-testing](https://jestjs.io/docs/snapshot-testing)
- [Saga Pattern - microservices.io/patterns/data/saga.html](https://microservices.io/patterns/data/saga.html)
- [ThoughtWorks Tech Radar: Consumer-Driven Contract Testing - thoughtworks.com/radar/techniques/consumer-driven-contract-testing](https://www.thoughtworks.com/radar/techniques/consumer-driven-contract-testing)

## Key Findings

### 1. The mock boundary principle
- The Google "Don't Overuse Mocks" guideline: mock at the boundary of the system you control. Mocking your own internal classes couples tests to implementation; mocking external systems (DB, message broker, third-party API) is the only safe place to draw the line.
- For a NestJS CQRS command handler, the system boundary is:
  - **Outbound**: PostgreSQL (TypeORM repositories), NATS (event publish), Redis (idempotency, cache), HTTP clients to external services.
  - **Inbound**: GraphQL resolvers, REST controllers, NATS subscribers — these CALL the handler.
  - **Internal**: domain entities, value objects, factory methods, pure functions, the handler itself.
- The correct unit test for a command handler mocks ONLY the outbound boundary. The handler executes its real logic, calls real factory methods, computes real business rules, and only the side-effect collaborators (repository.save, eventBus.publish, redis.set) are mocked.
- The London-school anti-pattern is to mock domain entities and value objects: `jest.spyOn(Batch.prototype, 'recordMortality')`. This produces tests that assert the handler called `recordMortality` but never assert that mortality was correctly applied. The behavior is invisible to the test.

### 2. Contract testing for command handlers
- A command handler's contract is: "given this command and this aggregate state, produce this new state and emit these events."
- The test must verify three things:
  1. **State transition**: the aggregate is mutated correctly (often verified via the captured argument to `repository.save`).
  2. **Event emission**: the correct event(s) are published with the correct payload.
  3. **Idempotency / authorization**: invalid commands are rejected, duplicate commands are no-ops.
- Anti-pattern: tests that only verify the handler "called the repository" without inspecting WHAT was passed. `expect(repository.save).toHaveBeenCalled()` is assertion-free.
- Correct pattern: `expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'CLOSED', closedAt: expect.any(Date), finalFcr: 1.85 }))`.
- For event emission: `expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'BatchClosed', batchId, finalFcr: 1.85 }))`. Mocking the EventBus and inspecting publish calls is the canonical way to verify event contracts at the unit level.

### 3. Given-When-Then for handler tests
Martin Fowler's Given-When-Then is the canonical structure. For a `CloseBatchHandler`:
- **Given**: an active batch with quantity=0, biomass=0, days=120, totalFeed=180kg, totalGain=100kg.
- **When**: `closeBatchHandler.execute(new CloseBatchCommand(batchId))`.
- **Then**: repository.save called with status=CLOSED and finalFcr=1.8; BatchClosed event emitted with correct payload; legal hold check invoked; audit log entry created.

This structure makes test intent obvious to readers and enforces a single behavior per test.

### 4. Mocking the EventBus and verifying event emission
- NestJS `EventBus` from `@nestjs/cqrs` is a singleton DI provider. Mock it via `Test.createTestingModule({ providers: [{ provide: EventBus, useValue: createMock<EventBus>() }] })`.
- Use `@golevelup/ts-jest` `createMock` to generate type-safe deep mocks. Manual `jest.fn()` mocks lose type safety and miss new methods when the interface changes.
- For aqua-saas: handlers MUST go through the outbox, not directly through EventBus. So the unit test mocks the outbox repository (`OutboxRepository`) and asserts that an outbox row was inserted with the correct event payload — NOT that NATS was called.
- Event payload assertion: use `expect.objectContaining({ ... })` for forward compatibility. New event fields should not break existing tests as long as the fields the test cares about remain present and correct.

### 5. Saga testing
- A saga listens for events and dispatches commands in response. Testing a saga requires asserting that the command bus was called with the correct command in response to a specific event sequence.
- Two patterns:
  - **State-machine-style**: instantiate the saga, send it events directly, assert on output commands.
  - **Process-test-style**: dispatch the trigger event into a TestingModule with the saga registered, intercept the resulting command via a mocked CommandBus, assert.
- Saga tests must cover: success path, failure path (command rejected), compensation path (rollback command emitted), and idempotency (replaying the same trigger event does not duplicate the command).
- For aqua-saas: distributed saga tests (across services via NATS) belong in integration tests, not unit tests. Unit-test the saga's local logic; integration-test the cross-service flow with testcontainers + a real NATS instance.

### 6. Repository mocking pitfalls
- TypeORM repositories have ~30 methods (find, findOne, save, update, delete, createQueryBuilder, etc.). Manual mocks miss methods. Use `createMock<Repository<Entity>>()`.
- The `createQueryBuilder` chain (`.where().andWhere().leftJoin().getMany()`) is hard to mock. Either:
  - Build a fluent mock (`createMock` returns a deep proxy that auto-chains).
  - Hide the query builder behind a domain repository method (`findActiveBatchesByTenant(tenantId)`) and mock only the domain method.
- Hiding the query builder is preferred: it makes the unit test simpler AND forces a proper repository abstraction in production code. Tests guide architecture.
- A common mistake: mocking `repository.save` to return the same entity passed in. This is a self-fulfilling prophecy — the test passes regardless of whether `save` would actually persist. Verify that `save` was called with the expected mutated state, do not rely on the return value.

### 7. Snapshot testing — when it's fine, when it's poison
- Snapshot tests serialize a value and compare against a stored snapshot file. They are useful for:
  - **Output formatters** (Markdown generators, CSV exporters, error message formatters): the output is large and structurally meaningful.
  - **GraphQL schema diffs**: catch unintended schema changes.
  - **API contract diffs**: serialized response objects.
- Snapshot tests are POISON for:
  - **React component output**: massive snapshots with class names, hashes, and timestamps. Every refactor breaks them. Reviewers auto-approve diffs without reading.
  - **Domain object state**: better expressed as explicit `expect(...).toBe(...)` assertions.
  - **Anything with non-deterministic content**: dates, UUIDs, file paths. The "fix" (custom serializer) accumulates complexity.
- The Kent C. Dodds rule: snapshot tests should fit on one screen. If reviewers cannot read the snapshot in <30 seconds, it is too big and will be rubber-stamped.
- The Google rule: a snapshot test that breaks 10+ times in a quarter without revealing a real bug is net-negative — delete it.
- Inline snapshots (`expect(x).toMatchInlineSnapshot('...')`) are preferred over file snapshots when the snapshot is small. The expected value lives in the test file, where reviewers see it during code review.
- Snapshots are an additional supply-chain attack surface (see jest-30-vitest research): a malicious PR can inject payloads via snapshot updates, and rubber-stamp review approves them silently.

### 8. Test doubles taxonomy (Fowler)
- **Dummy**: a value passed but never used. `null`, placeholder strings.
- **Stub**: returns canned values for queries. `repository.findOne.mockResolvedValue(batch)`.
- **Spy**: records calls for later inspection. `jest.spyOn(service, 'method')`.
- **Mock**: a stub with verification. Asserts on calls AND interactions.
- **Fake**: a working but lightweight implementation. In-memory repository, in-memory cache.

For CQRS handlers, the right mix is: stub for queries (`findOne`), mock for commands (`save`, `publish`), fake for collaborators that have their own logic (e.g., a fake authorization checker that returns true/false based on test setup).

### 9. Authorization and tenant isolation in handler tests
- Every command handler should verify the requesting user has permission to act on the target aggregate. The handler test must include negative cases: rejected because tenant mismatch, rejected because role insufficient, rejected because aggregate not in correct state.
- A handler test that ONLY tests the happy path is incomplete. Missing negative tests = HIGH finding.
- Tenant scoping: the test must mock the `TenantContext` (or `RequestContext`) to provide a specific tenant ID, then verify the handler uses it in repository queries. A handler that hardcodes tenant ID, or accepts it from the command payload without validation against the requesting tenant, is a privilege escalation bug — and a test that does not catch it is incomplete.

### 10. Async event verification
- After dispatching a command, events fly through the EventBus asynchronously. Tests must `await` the handler's return AND any async event handler chain.
- For sagas that produce commands in response to events, use `firstValueFrom` (RxJS) to wait for the produced command, with a timeout to fail fast.
- Avoid `setImmediate`/`process.nextTick` workarounds — they signal that the handler has hidden async work outside the awaited promise chain. Refactor the handler to await its own work.

## Security Concerns

- **Mocks hiding security checks:** if a handler test mocks the authorization guard or `TenantContext` to always return success, the test cannot detect a removed `@TenantGuard` decoration. Authorization MUST be verified in handler tests via real (or fake) guards, not unconditionally-success mocks.
- **Mocked event emission masking event leakage:** if a test mocks the EventBus, it cannot verify that the event payload is free of secrets (passwords, tokens). Mocked publishers should be inspected for payload contents in addition to call counts.
- **Snapshot tests as supply-chain vector:** see jest-30-vitest research. Snapshot updates in PRs must be reviewed line-by-line. Auto-approving snapshots is forbidden.
- **Test-only credentials in command tests:** test commands often include hardcoded passwords or tokens. These must be obviously fake (`"test-password-do-not-use"`) and never copy production credentials.
- **Mocking the database hides SQL injection bugs:** a handler that constructs SQL strings from command input passes a mocked-DB test even when the SQL is exploitable. Integration tests with real DB are mandatory for code that touches raw SQL.
- **Race condition coverage:** unit tests cannot detect race conditions in multi-step transactions. Integration tests with real DB and concurrent execution are needed. Unit tests that "verify" atomic behavior via mock ordering are providing false confidence.

## Performance Concerns

- **Per-test TestingModule rebuild:** building a NestJS TestingModule per test is expensive (~50-200ms). Build it once in `beforeAll`, retrieve fresh handler instances per test. This shaves seconds-to-minutes off long suites.
- **Deep mocks over-mock:** `createMock<DeepThing>()` walks the type graph and generates a proxy for every method. For deeply nested DI graphs this can be slow on large interfaces. Mock at the interface boundary, not the entire app.
- **Snapshot file I/O:** snapshot tests read/write files on disk per assertion. Large snapshots multiply this cost. Inline snapshots avoid file I/O but bloat test files.
- **Spy memory leaks:** `jest.spyOn(...)` without `restoreMocks: true` accumulates spy state across tests, slowing down later runs. Always set `restoreMocks: true` in Jest config.
- **Async event verification timeouts:** waiting for events with arbitrary timeouts (e.g., `await new Promise(r => setTimeout(r, 100))`) is the #1 source of slow tests. Use deterministic completion signals (RxJS subjects, mock callbacks) instead.

## Architectural Implications for test-runner reviews

When auditing CQRS handler tests, verify:

1. **Mock boundary at outbound dependencies only:** repositories, EventBus, OutboxRepository, Redis, NATS clients. Mocking domain entities/factories = HIGH (London-school overreach).
2. **Repository.save assertions inspect payload**, not just call count. `toHaveBeenCalled()` without `toHaveBeenCalledWith` = HIGH (assertion-free).
3. **Event emission asserted via outbox row**, not direct EventBus mock, since aqua-saas uses transactional outbox. Mocking EventBus directly in handler test = HIGH (does not match production path).
4. **Negative authorization tests** for every handler: tenant mismatch, role insufficient, aggregate state invalid. Missing = HIGH.
5. **TestingModule built in `beforeAll`**, not `beforeEach`. Per-test rebuild = MEDIUM (slow suite).
6. **No mocked domain entities/value objects.** `jest.spyOn(Batch.prototype, ...)` = HIGH (hides logic from test).
7. **Saga tests cover success, failure, compensation, idempotency.** Missing any = HIGH.
8. **Snapshot tests bounded:** small (<50 lines), inline preferred, never on React component output without justification. Large file snapshots = MEDIUM.
9. **`createMock` from `@golevelup/ts-jest`** for type-safe mocks. Manual `jest.fn()` mocks of large interfaces = LOW (loses type safety).
10. **`restoreMocks: true`** in Jest config. Missing = LOW (memory leaks).
11. **No `setTimeout` waits in async tests.** `await sleep(100)` = HIGH (flake source, slow suite).
12. **Tests for raw SQL paths use real DB**, not mocked repository. Mocked-DB raw SQL test = HIGH (cannot detect injection).
13. **Test commands use obviously-fake credentials.** Production-shape credentials = MEDIUM (PII risk).
14. **Handler tests follow Given-When-Then structure.** Missing structure = LOW (readability).

## Domain Rule Additions for test-runner

- CQRS command handler tests MUST mock at outbound boundaries only: repositories, OutboxRepository, Redis, NATS clients, HTTP clients. Mocking domain entities or value objects = HIGH finding.
- Handler tests MUST inspect the payload passed to `repository.save` via `toHaveBeenCalledWith(expect.objectContaining({ ... }))`. Bare `toHaveBeenCalled()` = HIGH finding.
- For aqua-saas (transactional outbox in use), event emission MUST be asserted via `OutboxRepository.save` calls, NOT by mocking `EventBus` directly. EventBus-only assertion = HIGH finding (does not match production publish path).
- Every command handler test file MUST include negative cases: tenant mismatch, role insufficient, aggregate state invalid. Missing negative cases = HIGH finding.
- TestingModule MUST be built in `beforeAll` and reused across tests in the file. Per-test rebuild = MEDIUM finding.
- Mocking domain methods (`jest.spyOn(Aggregate.prototype, 'method')`) is FORBIDDEN — instantiate real aggregates in tests. Mocked domain methods = HIGH finding.
- Saga tests MUST cover four scenarios: success, downstream failure, compensation, idempotent replay. Missing any = HIGH finding.
- Snapshot tests MUST be inline when feasible and bounded to <50 lines. File snapshots > 100 lines = MEDIUM. React component snapshots without justification = HIGH (bypassed by reviewers).
- Type-safe mocks via `createMock<T>()` (from `@golevelup/ts-jest`) MUST be preferred over manual `jest.fn()` for interfaces with > 5 methods.
- `restoreMocks: true` MUST be set in Jest config. Missing = LOW finding.
- `setTimeout` / `setImmediate` waits in tests are FORBIDDEN — use deterministic completion signals or Jest fake timers. Each occurrence = HIGH finding.
- Tests covering raw SQL or query-builder code paths MUST use real Postgres via testcontainers, not mocked repositories. Mocked-DB raw SQL tests = HIGH finding (cannot detect injection or planner regressions).
- Test commands MUST use synthetic credentials (`test-password-<uuid>`) and never copy production-shape PII. Production-shape PII in test commands = MEDIUM finding.
- Handler tests SHOULD follow Given-When-Then structure with clearly delineated arrange/act/assert sections. Missing structure = LOW finding (readability).
