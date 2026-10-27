# ADR-053 — PG16 constant-default ADD COLUMN is a catalog-only change

- **Status:** Proposed; approved by the architectural-arbiter on 2026-10-26. Amends
  `docs/runbooks/migration-authoring.md` (the step-3 checklist item at :57-60, the anti-pattern rows
  at :176 and :178, the ADR list at :206) and replaces every other normative copy of the rule
  (Decision 5). Supersedes no ADR.
- **Date:** 2026-10-26
- **Owner:** platform operator (migrations)
- **Affected owners (notified):** data-expert, primary on migration-delta safety
  (`.claude/agents/database-reviewer.md:39`; its rules are encoded in the gate,
  `tools/gates/migration-sql-lint.ts:6-7`); database-reviewer, secondary on schema state
  (`.claude/skills/add-entity-field.md:80`).
- **Tracking:** module-boundaries plan, PKG-00 (governance). The finding ID is allocated through
  `npm run findings:add`, because a hand-written ID fails
  `docs/reviews/_registry/findings.jsonl.schema.json:24`. Narrative:
  `docs/reviews/claude/2026-10-26-module-boundaries.md`.
- **Relates to:** ADR-011 and ADR-012 (schema ownership and drift), ADR-030 (day-one reset), all
  cited by the runbook at :206; ADR-050 (who reviews agent, knowledge, skill and research paths);
  ADR-051 and ADR-052 (same plan).
- **Evidence:** code references are repo-relative at 33de2433b.

## Context

The runbook bans a one-step NOT NULL column add:

- `docs/runbooks/migration-authoring.md:178` lists `ALTER TABLE ADD COLUMN NOT NULL DEFAULT ...`
  on a populated table as an anti-pattern ("rewrites every row in one tx") and prescribes nullable
  add → backfill → SET NOT NULL.
- The step-3 checklist (:57-60) allows ADD COLUMN NOT NULL "ONLY when paired with a backfill + SET
  NOT NULL three-step". `CLAUDE.md:124` repeats it: "nullable column → backfill → NOT NULL".
- The rule is restated in agent prompts, knowledge, skills, contributor and ARIA documents (full
  list in Decision 5). data-expert rates a single-step NOT NULL add on existing data HIGH
  (`.claude/agents/data-expert.md:92`), and two copies state the opposite of Decision 1:
  `.claude/knowledge/layer-1-typeorm.md:33` says `DEFAULT now()` "triggers a full table rewrite",
  and `data-expert.md:93` classes `now()` as volatile.

The stated reason has not held since PostgreSQL 11. When ADD COLUMN carries a non-volatile
DEFAULT, PostgreSQL evaluates it once and stores the value in `pg_attribute` (`atthasmissing`,
`attmissingval`). Existing rows are not touched, the heap and its indexes keep their files, and NOT
NULL needs no verification scan because no row can read NULL. Every Postgres in the platform is 16:

- `.github/manifests/postgres-image.json:5` pins `timescale/timescaledb-ha:pg16@sha256:b3d0…`, and
  :11 records `postgres_major: 16`, which `tests/invariants/postgres-image-uniformity.spec.ts:127`
  asserts.
- The production image builds `FROM` that digest
  (`infrastructure/docker/Dockerfile.postgres-walg:6`).
- The migration harness boots the same digest (`libs/migration-harness/src/setup.ts:73-74`).

The SQL gate and the merged history already disagree with the runbook:

- `tools/gates/migration-sql-lint.ts:441-455` (R2) fires only when NOT NULL has no DEFAULT in the
  same clause. Any DEFAULT passes it, a constant one and a volatile one alike, although a volatile
  default rewrites the table.
- `git grep -i -E 'ADD COLUMN.*NOT NULL DEFAULT' -- ':(glob)apps/**/migrations/*.ts'` finds 48
  lines in 34 migration files, for example
  `apps/auth-service/src/migrations/1801400000000-AddRefreshTokenRememberMe.ts:28`. The `:(glob)`
  magic stops `*` from crossing `/`, so archived migrations under `.archive/` and specs under
  `__tests__/` are not counted. The gate is forward-only (`migration-sql-lint.ts:9-11`), so these
  lines stay as they are.

So the runbook forbids what the gate passes, and the gate passes the one case that really rewrites.

Three more facts bound the decision:

- The harness image matches production only by "reviewer discipline" (`setup.ts:68-71`). The
  uniformity invariant reads `image:` lines in workflows and compose files only
  (`tools/gates/postgres-image-manifest.ts:23-26`), so `setup.ts` is outside it. A proof on the
  harness image proves nothing about production unless the two are bound.
- The harness can also run against an external server (`MIGRATION_HARNESS_PG_URL`,
  `setup.ts:43-57,282-286`), whose major version the harness does not check.
- Production migrations run in the db-migrate orchestrator, one transaction per migration: start
  (`apps/db-migrate/src/migration-orchestrator.ts:534`), `up()` (:540), the postCondition probe
  (:541), commit (:543). Every lock a migration takes is held until that commit.

Why now: the module-boundaries plan adds a NOT NULL module key with a constant default to 7 farm
registry tables (PKG-13, `DEFAULT 'farm'`) and to alert rules and escalation policies (PKG-22,
`DEFAULT 'sensor'`), in every tenant schema, inside the 1200 s migrate budget
(`scripts/deploy/droplet-up.sh:312`). Under the runbook as written, each table would need an UPDATE
of every row, a separate NOT NULL contract release and a nullable-entity window (plan rule C3).

## Decision

1. **The rule.** On PostgreSQL 16, a statement
   `ALTER TABLE <table> ADD COLUMN [IF NOT EXISTS] <col> <type> NOT NULL DEFAULT <constant>`
   changes only the catalog. It is allowed on a populated table without a backfill when all of the
   following hold:
   - the table is an existing ordinary heap table (Decision 2 lists what is not);
   - `<constant>` is on the allowlist:
     - a literal, optionally cast: `'farm'::farm_registry_module_enum`, `0`, `false`, `'{}'::jsonb`;
     - or `now()`, `CURRENT_TIMESTAMP` or `CURRENT_DATE`. These are stable, not volatile, so they
       are evaluated once and every existing row reads the migration's transaction time;
   - the constant is the correct value for every existing row. Neither PostgreSQL nor the gate can
     check this, because it is a fact about the data. The author states the reason in a SQL comment
     in the same statement, `-- ADR-053: <why this value is true for every existing row>`. The
     gate requires the marker (`add-column-exemption-shape`), as gate rule R1 requires
     `-- DESTRUCTIVE:` (`migration-sql-lint.ts:432`), and the reviewer judges it. For example,
     `created_at … DEFAULT now()` fails this condition, because legacy rows would claim to be
     created at migration time. That column is a backfill (Decision 2);
   - the clause carries no inline `CHECK`, `REFERENCES`, `UNIQUE` or `PRIMARY KEY`. Each of these
     scans or indexes the whole table under the same ACCESS EXCLUSIVE lock, although nothing is
     rewritten, and a filenode probe cannot see a scan. They go in their own migrations
     (`NOT VALID` → `VALIDATE`, or `CREATE INDEX CONCURRENTLY`), as PKG-13 already places them in
     1823300000000 and 1823400000000;
   - the migration has the shape in Decision 3.
2. **Where the rule does not apply.** These keep nullable add → backfill → SET NOT NULL:
   - a volatile default: `gen_random_uuid()`, `uuid_generate_v4()`, `clock_timestamp()`, `random()`,
     any `nextval()`, `serial`/`bigserial`, `GENERATED … AS IDENTITY`. PostgreSQL rewrites the table
     and every index under ACCESS EXCLUSIVE;
   - a `GENERATED ALWAYS AS (…) STORED` column, which is computed for every row and also rewrites.
     Precedent:
     `apps/farm-service/src/database/migrations/1822000000000-ExtendParamEquipmentToChannelSources.ts:327-335`;
   - a column whose type is a domain with constraints. PostgreSQL rewrites to check the domain on
     every row. No migration creates a domain today
     (`git grep -i 'CREATE DOMAIN' -- ':(glob)apps/**/migrations/*.ts'` finds none). The gate cannot
     see a domain's definition from the ADD clause, so it flags every `CREATE DOMAIN`
     (`add-column-rewriting-default`), and the first domain needs an amendment to this ADR before
     it merges;
   - a value that depends on other columns of the row, or one that is not the same true fact for
     every existing row (a creation time, an owner that varies). That is a backfill by definition;
   - a column that already exists. `SET NOT NULL` on an existing column scans the table under ACCESS
     EXCLUSIVE. PKG-18 (`departments_hr`: backfill, then SET NOT NULL) and the PKG-22 incident
     column (batched backfill, then `CHECK … NOT VALID` → `VALIDATE` → `SET NOT NULL`) keep their
     contracts;
   - a table that is not a plain heap table (a TimescaleDB hypertable, a partitioned table). The
     proof below does not cover it, so this ADR grants it no exemption. A NOT NULL add there needs
     its own harness proof on the pinned image before it merges. No package in the plan adds one.
3. **The migration's shape.** A catalog-only ADD still takes ACCESS EXCLUSIVE on the table, and the
   orchestrator holds the lock until that migration's commit (`migration-orchestrator.ts:530-544`).
   While the ADD waits for the lock, PostgreSQL queues every later statement on the table behind the
   pending request, readers included. The repo's own precedent says so: "a waiting ACCESS EXCLUSIVE
   request blocks every later reader of the table"
   (`apps/alert-engine/src/database/migrations/1801200000000-AddAlertHistorySiteAndModule.ts:22-27`).
   Locks taken in one transaction add up: with seven ADDs in one migration, the first table stays
   locked while the migration waits for each of the other six. Therefore:
   - **One table per migration.** A migration that uses the exemption alters exactly one table,
     named as a literal. PKG-13's seven tables are seven migrations and PKG-22's two tables are
     two. Each migration is its own transaction, so a table is locked only for its own catalog
     change, and a wait on one table never extends the lock on another. Ordering the seven ADDs
     inside one transaction cannot do this, because the earlier locks are still held while the
     later ones wait.
   - **A bounded lock wait of at most 2 s.** The migration sets `SET LOCAL lock_timeout` to 2 s or
     less as a literal statement before its first `ALTER TABLE`, in `up()` and in `down()`. Then a
     reader waits at most that long plus the catalog change, and when the lock is not granted in
     time the migration fails. 2 s is the stricter of the repo's precedents: 1801200000000:36 on
     the per-tenant `alert_history`, `apps/db-migrate/src/orphan-type-reclamation.ts:85`,
     `apps/db-migrate/src/stray-tenant-journal-heal.ts:99`, and the skill bound "no ACCESS
     EXCLUSIVE
     > 2s on a live-write table" (`.claude/skills/run-migration-prod.md:25`). The other precedent uses
     > 10 s
     > (`apps/hr-service/src/database/migrations/1802400000000-AddDepartmentHrModuleCode.ts:26-28`).
     > A timeout rolls back that migration and rethrows (`migration-orchestrator.ts:553-566`). The
     > deploy then stops before any service container starts (`droplet-up.sh:331-337`), and a re-run
     > resumes, because `ADD COLUMN IF NOT EXISTS` (gate rule R9) is replayable.
   - **Transactional, without `withDdlSafety`.** The migration does not declare
     `transaction = false`: without a transaction, `SET LOCAL` does nothing
     (`libs/backend-common/src/database/base-migration.ts:612-615`), and the orchestrator opens none
     (`migration-orchestrator.ts:530-535`). It does not call `withDdlSafety`, for three reasons:
     - the helper issues its own `SET LOCAL lock_timeout` (:690), which overrides an earlier literal
       and defaults to 30 s (:658);
     - its `schema` option re-pins `search_path` to a fixed schema (:678-686), where per-tenant
       replay needs the orchestrator's pin (`migration-orchestrator.ts:478-480`);
     - its `lockTimeoutMs` (:587) is a TypeScript argument, which the SQL gate cannot read. The gate
       reads only `.query()` template literals (`migration-sql-lint.ts:717-749`).
   - **Nothing else in the migration.** Besides its `SET LOCAL` statements, read-only `SELECT`s and
     the `ADD COLUMN` clauses on its one table, the migration holds only the inverse
     `DROP COLUMN IF EXISTS` of an added column in `down()`. Enum types, index builds, constraints,
     FK validation, UPDATEs and policy cloning go in their own migrations, as PKG-13 already does
     with 1823100000000 (enum), 1823300000000 (indexes) and 1823400000000 (integrity).
4. **The default bridges a transition; it is not the model.** The entity declares no default (plan
   PKG-13, critic decision). A writer that does not know the column yet, such as an old container
   in the deploy window, inserts without it and gets the default. The contract release drops the DB
   default once no writer omits the column. `DROP DEFAULT` changes only `pg_attrdef`, so rows that
   existed at ADD time keep reading the stored value.
5. **Every normative copy of the rule changes in the PKG-00 PR.** A copy left behind would keep
   rating PKG-13's migrations HIGH. Each copy is replaced by a pointer to the runbook row and this
   ADR. A copy is not paraphrased, so the rule exists once.
   - **The runbook** (PKG-00 author):
     - :57-60, the "Blue-green safety" item, becomes: "ADD COLUMN … NOT NULL in one statement only
       with a constant DEFAULT that is true for every existing row, on an existing ordinary table,
       one table per migration, under `SET LOCAL lock_timeout` ≤ 2 s (ADR-053; gate rules
       `add-column-rewriting-default` and `add-column-exemption-shape`). Every
       other NOT NULL add uses nullable → backfill → SET NOT NULL."
     - :178 is replaced by a row whose pattern is "`ADD COLUMN … NOT NULL DEFAULT` with a volatile
       default, a `GENERATED … STORED` column, a constrained domain type or an inline constraint, on
       a populated table". Its reason is "rewrites or scans the table under ACCESS EXCLUSIVE", and
       its alternative stays "nullable add → backfill → SET NOT NULL".
     - In :176 (`SAVEPOINT`), the alternative "three-step blue-green ADD" becomes "an ADD shape
       allowed by the Blue-green safety item".
     - :206 adds "053 Constant-default ADD COLUMN".
   - **Root documents** (PKG-00 author): `CLAUDE.md:124`, with the budget checked by
     `tests/invariants/claude-md-accuracy.spec.ts`, and `CONTRIBUTING.md:107`.
   - **The gate** (PKG-00 author): the gate rule R2 header (`migration-sql-lint.ts:22-25`) and
     message (:451-454) remain correct for NOT NULL without DEFAULT. Each gains the ADR-053
     option.
   - **Agent prompts, knowledge and skills.** prompt-writer makes these edits, because it holds the
     Edit and Write tools (`.claude/agents/_maintenance/prompt-writer.md:6`). The rule's trace is
     the codebase reference its rule-trace clause asks for (:150). Review follows the routing
     table: architectural-arbiter is primary for these paths (ADR-050, ratified rows). data-expert
     and database-reviewer are notified.
     - `.claude/agents/data-expert.md:92` (the 3-step rule, rated HIGH) and :93 (`now()` called
       volatile): both become pointers. data-expert traces its rules to `docs/research/data-expert/`
       (:46,172), and
       `docs/research/data-expert/2026-04-08-postgresql-migration-safety-idempotent.md:24` calls
       `now()` and `CURRENT_DATE` volatile. That line gets a note saying ADR-053 supersedes it.
     - `.claude/knowledge/layer-1-typeorm.md:26-30` (the 3-step rule) and :33 (`DEFAULT now()`
       triggers a full rewrite). :33 is corrected: `now()`, `CURRENT_TIMESTAMP` and `CURRENT_DATE`
       are stable and do not rewrite (Decision 1), while `gen_random_uuid()` does (Decision 2).
     - `.claude/skills/add-entity-field.md:68,72,76,123`, with :141 naming the two new gate rules
       next to R2.
     - `.claude/skills/run-migration-prod.md:3`.
   - **ARIA-scoped copies** (the operator, in the same PR, under `.github/CODEOWNERS:13,36`).
     aria-prompt-writer cannot make them: its tools are read-only, and it renders only `aria-*`
     roster prompts (`.claude/agents/_maintenance/aria-prompt-writer.md:6,22-25`).
     - `.claude/agents/_shared/aria-code-writing-standards.md:57-58`. Its :6 already lets CLAUDE.md
       win a conflict.
     - `docs/aria/MISSION.md:60-61` and `docs/aria/MISSION_SPEC.md:109-110`.
   - **Unchanged, with the reason:**
     - `aria-kernel/aria_kernel/validation_matrix_gate.py:38-40`: its marker regex (:175-179)
       already accepts `NOT NULL`.
     - `libs/backend-common/src/database/migration-helpers.ts:68-74,144`: the helper adds only
       nullable columns, by construction.
     - `scripts/migration/baseline-generator.ts:260-263` and
       `docs/runbooks/baseline-migration-generation.md:104`: they audit only the
       `1800000000000-Baseline.ts` files (:244-246), which create tables rather than alter them.
     - Dated records (plans, reviews, recommendations, archived migrations) are not edited.
       `docs/adr/038-auth-role-table-rls.md:54` stays correct, because its column takes values
       from the FK chain, which is a backfill under Decision 2.

## Enforcement

| Test                                                                                                                                                             | What it pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Runs                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `libs/migration-harness/src/__tests__/pg16-constant-default-catalog-only.integration.spec.ts` (new, PKG-00)                                                      | It first asserts that the server's major version (`server_version_num / 10000`) equals the manifest's `postgres_major`, so an external server of another major fails by name. The table is seeded with rows and an index, and carries ENABLE + FORCE RLS like a tenant table. For each constant form in Decision 1, the table's and every index's `pg_relation_filenode` are unchanged, `atthasmissing` is true, and existing rows read the default. For each case in Decision 2 (volatile default, identity, `GENERATED … STORED`, constrained domain), the filenode changes. These negative controls prove that the probe can see a rewrite. A following `DROP DEFAULT` leaves the filenode and the legacy row values unchanged. Inline constraints scan without a rewrite, so this probe cannot see them; `add-column-rewriting-default` covers them.                                                                                                                                                                                         | When `migration-harness` is affected (`.github/workflows/ci-affected.yml:457-461`)                          |
| `tests/invariants/postgres-image-uniformity.spec.ts` (extended, PKG-00)                                                                                          | `DEFAULT_POSTGRES_IMAGE` (`setup.ts:73-74`) equals the manifest `image`. This replaces the reviewer discipline of `setup.ts:68-71`. A Postgres bump must therefore edit `setup.ts`, which affects `migration-harness` and re-runs the proof on the new image.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Every PR (invariants)                                                                                       |
| `tools/gates/migration-sql-lint.ts` + `.spec.ts`, new per-chunk rule `R13-add-column-rewriting-default` (HIGH, PKG-00; the gate's next free id, not release R13) | An `ADD COLUMN` on a table not created in the same chunk is flagged when it carries `GENERATED … STORED`, an identity or serial type, or a DEFAULT outside the Decision-1 allowlist (an interpolated `${…}` DEFAULT counts as outside). It is also flagged when it is `NOT NULL DEFAULT` with an inline `CHECK`, `REFERENCES`, `UNIQUE` or `PRIMARY KEY`. Any `CREATE DOMAIN` is flagged too. R2 (:441-455) keeps catching NOT NULL without DEFAULT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Every PR (`.github/workflows/quality-gates.yml:137-142`) and pre-commit (`.husky/pre-commit:31`)            |
| Same gate, new file-scope rule `R14-add-column-exemption-shape` (HIGH, PKG-00)                                                                                   | It applies to a file holding a Decision-1 ADD, which is `NOT NULL DEFAULT <allowlisted constant>` on a table not created in that file. In such a file it requires: (a) the same-statement `-- ADR-053:` marker; (b) a `SET LOCAL lock_timeout` of 2 s or less before the first `ALTER TABLE` of `up()` and of `down()`, and no larger value anywhere in the file; (c) every `ALTER TABLE` names the same literal table, so an interpolated target fails; (d) no statement other than `SET LOCAL`/`set_config`, `SELECT`, `ADD COLUMN` on that table and the inverse `DROP COLUMN IF EXISTS` of a column it adds; (e) no `transaction = false` and no `withDdlSafety(` call. A file-scope rule is a new kind beside the per-chunk `Rule` (:117-123), because `scanSqlChunks` (:759-780) shows each rule one chunk at a time and cannot see a timeout set in another `.query()` call. It runs once per file in `inspectMigrationSource` (:795-800), which ARIA's `sql-migration-safety-adapter` also calls (:792), so the two agree on every file. | As `add-column-rewriting-default`                                                                           |
| PKG-13 harness spec (plan PKG-13 tests)                                                                                                                          | Under FORCE RLS, each of the seven per-table migrations (timestamps from 1823200000000, before 1823300000000) leaves its table's filenode unchanged, and legacy rows read `farm`. After `1823500000000-DropRegistryModuleDefault`, they still read `farm`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | With PKG-13                                                                                                 |
| PKG-22 harness spec (this ADR adds the assertion)                                                                                                                | The alert rules and escalation policies keep their filenodes when the `module` column is added, each in its own migration, and legacy rows read `sensor`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | With PKG-22                                                                                                 |
| `tests/invariants/common-kind-module-key.spec.ts` (new in PKG-13, plan §7)                                                                                       | PKG-13's source invariant for the module key on common kinds. It is listed because PKG-13 relies on this ADR; it does not test PG behaviour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Every PR                                                                                                    |
| `e2e/tests/integration/{tenant-provisioning-replay,tenant-clone-parity,schema-invariants}.spec.ts` (plan §7)                                                     | A tenant provisioned by replay gets the same column shape as a migrated one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `db-migration-check.yml` (:466, the `tenant-clone-parity` job at :361, the `schema-invariants` job at :508) |

## Consequences

- PKG-13 and PKG-22 add their keys with one catalog-only statement per table per tenant schema.
  There is no UPDATE of every row and no NOT NULL scan. The column is NOT NULL from its first
  release, so the entity can be non-null in that same release. Plan rule C3 ("The entity stays
  nullable until the release whose migration sets NOT NULL") still holds, because that release is
  the add release.
- The lock count stays the same (one ACCESS EXCLUSIVE per table per tenant schema), but no lock
  outlives its own table's change. In the worst case a reader of any one table waits about 2 s. The
  price is more migrations: PKG-13's one column migration becomes seven, and each costs one
  transaction and one ledger row per schema. The restore rehearsal against the 1200 s budget
  (plan §3) times this.
- On a table that is busy during the deploy, the 2 s bound can fail the migrate step. The deploy
  stops before the services start, and the operator re-runs it. Schemas and tables that were already
  migrated keep their committed columns. This is the precedents' stated posture
  (1802400000000:26-27).
- Legacy rows hold no physical value until the next table rewrite (`VACUUM FULL`, `CLUSTER`, a
  column type change). Readers cannot tell the difference, and the harness spec pins it after
  `DROP DEFAULT`.
- The boot drift validator does not compare defaults. Its documented scope excludes them
  (`libs/backend-common/src/database/schema-drift-validator.service.ts:69-74`). Its class registry
  has no default class: the eleven class ids
  (`libs/backend-common/src/database/schema-drift/drift-classes.ts:47-58`) and the registry
  entries labelled A to K (:93-220) include none. So the R6 window, in which the DB has `DEFAULT
'farm'` and the entity declares none, is not a boot drift. This answers the drift question that
  the plan left UNVERIFIED for that window (plan §8).
- The two new gate rules apply only to new or modified migrations (`migration-sql-lint.ts:9-11`).
  The 48 existing lines are not re-audited.
- PKG-00 gains code and tests (tier 3) beside the tier-4 runbook and prompt text. The one part that
  stays tier 4 is whether the `-- ADR-053:` reason is true. The gate checks only that the reason is
  stated.

## Alternatives considered

- **Keep the three-step for every NOT NULL add (runbook :178 as written).** Rejected. For a
  constant default the backfill writes a new version of every row in every tenant schema inside the
  migrate budget. It adds a contract release and a nullable-entity window. It buys no safety when
  the constant is the correct value for every existing row, which Decision 1 requires. The plan's
  critics recorded the decision for PKG-13: "ADD COLUMN with a constant default is catalog-only via
  ADR 053", with the restore rehearsal kept.
- **Keep the default permanently.** Rejected by the critic decision "The registry default is
  dropped in R7, before non-farm writes open in R8. Entities declare no default." A lasting
  `DEFAULT 'farm'` would silently label a sensor or HR row as farm.
- **A nullable column with the default only in the entity.** Rejected. Rows written by old
  containers would be NULL, the backfill would have to run again (C3), and the database would not
  hold "every common-kind row has an owner module".
- **All seven ADDs in one migration, ordered.** Rejected. Locks taken in one transaction are held
  until its commit (`migration-orchestrator.ts:534-543`). Whatever the order, the first table stays
  locked while the migration waits for up to six more lock timeouts. One table per migration bounds
  every table at one timeout.
- **`withDdlSafety` as the envelope.** Rejected for this rule. Its 30 s default
  (`base-migration.ts:658`) lets a pending ACCESS EXCLUSIVE request hold every reader for 30 s.
  Its own `SET LOCAL` (:690) overrides a literal one. Its `schema` option re-pins `search_path`
  (:678-686), which per-tenant replay must not do. And the gate cannot read its `lockTimeoutMs`
  argument.
- **Amend the runbook text alone.** Rejected as tier 4 only. Whether the change is catalog-only
  depends on the server version and on the default's volatility, and the harness image is bound to
  production by review alone (`setup.ts:68-71`). The proof, the image binding and the two new gate
  rules make it detectable.
- **A production `postCondition` that asserts `atthasmissing`.** Rejected. It runs after `up()`,
  inside the same transaction (`migration-orchestrator.ts:540-543`), so the rewrite and its lock
  have already happened. Failing then only aborts the deploy. The pre-merge proof on the same image
  catches it earlier.
- **Let the lint gate decide volatility itself.** Not possible. Volatility is a catalog property of
  each function. The gate uses a conservative allowlist, and the harness proves the semantics of
  every allowed form.

## Implementing packages

- **PKG-00 (R1):** this ADR, the runbook rows (:57-60, :176, :178, :206), the `CLAUDE.md:124` and
  `CONTRIBUTING.md:107` pointers, every Decision-5 copy (the prompt-writer edits and the operator's
  ARIA edits), the generic harness spec, the image-parity assertion, and the two new gate rules with
  their spec cases. These land before any migration that relies on the rule.
- **PKG-13 PR1 (R6):** the plan's single `1823200000000-AddRegistryModuleColumns` becomes seven
  migrations, one per table, timestamped from 1823200000000 and before
  `1823300000000-AddRegistryModuleIndexes`. These are the first users of the rule.
  **PR2 (R7):** `1823500000000-DropRegistryModuleDefault`.
- **PKG-22 PR1 (R6):** the `module` column on alert rules and on escalation policies, in two
  migrations. Duplicate-default resolution, policy cloning and the partial unique index each go in
  their own migrations. **PR2 (R7):** drops those defaults. The incident column does not use this
  rule.
- **Not covered:** PKG-18 (an existing column) and every drop in release R13.
