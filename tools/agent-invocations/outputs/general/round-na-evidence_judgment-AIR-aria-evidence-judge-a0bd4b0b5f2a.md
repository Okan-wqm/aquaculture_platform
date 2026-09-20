{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-35471772861",
  "claim_id": "claim_4e45ee126fce59cb",
  "details": {
    "agent_contract_hash": "sha256:e691c7f7c8196ae2f3624051fb0d1f2cef45d81280aaeaa90d7b901b005758b3",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-evidence-judge",
    "agent_text": "**Verdict: true_positive** (confidence 0.90). The absence claim reproduces mechanically against the adapter's own four match criteria, and the gap sits on a live auth control.\n\nWhat I verified at `e9b9d77`:\n- `apps/hr-service/src/common/guards/` holds exactly one file \u2014 the guard. No sibling spec, no `__tests__/` (`Glob`).\n- Repo-wide, the only `gql-auth*` files are the hr-service and farm-service guards; no `*gql-auth*.spec|test.ts` anywhere \u2014 so the adapter's basename criterion (`test-gap-adapter.ts:306`) cannot match.\n- No `*.spec.ts` in the repo mentions `GqlAuthGuard` or `gql-auth.guard`; no ts/js file outside hr-service imports the hr-service guard path \u2014 so the direct-import criterion (`test-gap-adapter.ts:315`) cannot match.\n- The 26 hr-service specs never `createNestApplication`, never `overrideGuard`, never send `authorization`/`Bearer`/`x-user-payload`, never assert `UnauthorizedException`. The nearest one, `hr.resolver.employee-pii.spec.ts:49`, constructs `new HRResolver(...)` directly, so decorators and guards never execute.\n- Existing security tests cover neighbours, not this guard: `no-dead-guards.spec.ts` (wiring only), `verified-user-assertion-mounted.spec.ts` (middleware order), `jwt-verification.utils.spec.ts` (the shared helpers it delegates to). Sibling guards in gateway-api, auth-service and admin-api-service each have an adjacent spec \u2014 hr-service's is the outlier.\n- Meanwhile the guard is on the request path of all 8 hr-service resolvers (`hr.resolver.ts:48` etc.), so the untested branches at `gql-auth.guard.ts:116-127` (HIGH-04 pre-auth roles check), `:131-133`, `:160-163`, `:166-182` protect employee PII, payroll, leave, scheduling, training and finance data.\n\nIdentity fields I cannot know (`claim_id`, `run_id`, `judgment_group_id`, `prompt_hash`) are marked in `details.identity_notes`; the executor force-sets the lease-bound ones.\n\n```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-evidence-judge-a0bd4b0b5f2a\",\n  \"claim_id\": \"claim_AIR-aria-evidence-judge-a0bd4b0b5f2a\",\n  \"agent_id\": \"aria-evidence-judge\",\n  \"role\": \"evidence_judgment\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/general/round-na-evidence_judgment-AIR-aria-evidence-judge-a0bd4b0b5f2a.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"verdict\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"true_positive. The adapter's claim 'no adjacent or importing test coverage signal' reproduces against each of its four match criteria (tools/aria-adapters/test-gap-adapter.ts:296-320): (1) no test file with basename gql-auth exists anywhere in the repository \u2014 the only gql-auth* files are the hr-service and farm-service production guards; (2) apps/hr-service/src/common/guards/ contains only gql-auth.guard.ts; (3) no apps/hr-service/src/common/guards/__tests__/ directory exists; (4) no *.spec.ts or *.test.ts in the repository imports ../common/guards/gql-auth.guard or names GqlAuthGuard \u2014 every import of the guard is a production resolver (apps/hr-service/src/hr/hr.resolver.ts:3 plus seven sibling resolvers). The nearest test, apps/hr-service/src/hr/__tests__/hr.resolver.employee-pii.spec.ts:49, constructs HRResolver directly so the @UseGuards decorator at hr.resolver.ts:48 never executes. The security branches at gql-auth.guard.ts:83-90, 97-102, 116-127, 131-133, 141-148, 160-163 and 166-182 therefore have zero executing tests, while the guard is the active auth control on all eight hr-service GraphQL resolvers.\",\n      \"evidence_refs\": [\n        \"apps/hr-service/src/common/guards/gql-auth.guard.ts:71\",\n        \"apps/hr-service/src/common/guards/gql-auth.guard.ts:116\",\n        \"apps/hr-service/src/common/guards/gql-auth.guard.ts:131\",\n        \"apps/hr-service/src/common/guards/gql-auth.guard.ts:166\",\n        \"apps/hr-service/src/hr/hr.resolver.ts:3\",\n        \"apps/hr-service/src/hr/hr.resolver.ts:48\",...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 110707,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 110707,
      "cache_read_input_tokens": 1482669,
      "inference_geo": "not_available",
      "input_tokens": 34,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 1515,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 1515,
          "cache_read_input_tokens": 118251,
          "input_tokens": 2,
          "output_tokens": 12046,
          "type": "message"
        }
      ],
      "output_tokens": 28610,
      "output_tokens_details": {
        "thinking_tokens": 16572
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "identity_notes": {
      "claim_id": "Not present in the rendered request; the executor force-sets the lease-bound claim_id (tools/aria-poc/ci_executor.py:2519-2526). The value above is shape-valid only.",
      "judgment_group_id": "Mint-owned (judge:<tool>:<run>:<finding>); request value takes precedence per judgment_bridge.",
      "prompt_hash": "Not computable on this route (no hashing tool); the kernel binds prompt_hash at mint and verifies it at submit (agent_invocations), so no value is fabricated here.",
      "run_id": "Not present in the rendered request; the kernel reads request.run_id first (judgment_bridge), so the null here is a fallback, not a claim.",
      "tool_id": "Taken from the adapter that mints this rule: tools/aria-adapters/test-gap-adapter.ts:252 and :257 name it test-gap-adapter."
    },
    "runtime_attempt_ledger_hash": "sha256:ccf3d7e1d068b62943948316ec04eb11f75128f88a0c6a62e88564b9f6c2c893",
    "searched_scope": {
      "content_greps": [
        "GqlAuthGuard|gql-auth\\.guard in **/*.spec.ts (0 matches)",
        "hr-service/src/common/guards/gql-auth\\.guard|hr-service.*GqlAuthGuard in *.{ts,tsx,js,mjs} (0 matches)",
        "overrideGuard|UnauthorizedException|Bearer|authorization|x-user-payload|createNestApplication in apps/hr-service/src/**/*.spec.ts (0 matches)",
        "GqlAuthGuard|gql-auth|UseGuards in tests/ and e2e/ (no reference to this guard)"
      ],
      "filename_globs": [
        "**/gql-auth*",
        "**/*gql-auth*.{spec,test}.ts",
        "apps/hr-service/src/common/guards/**/*",
        "apps/hr-service/**/*.spec.ts"
      ],
      "not_executed": [
        "coverage tooling",
        "test runs"
      ]
    },
    "verdict": {
      "confidence": 0.9,
      "evidence_refs": [
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:71",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:83",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:97",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:116",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:131",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:141",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:148",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:161",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:166",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:177",
        "apps/hr-service/src/hr/hr.resolver.ts:3",
        "apps/hr-service/src/hr/hr.resolver.ts:48",
        "apps/hr-service/src/hr/__tests__/hr.resolver.employee-pii.spec.ts:49",
        "apps/farm-service/src/common/guards/gql-auth.guard.ts",
        "tools/aria-adapters/test-gap-adapter.ts:190",
        "tools/aria-adapters/test-gap-adapter.ts:271",
        "tools/aria-adapters/test-gap-adapter.ts:296",
        "tools/aria-adapters/test-gap-adapter.ts:315",
        "tests/invariants/no-dead-guards.spec.ts:10",
        "tests/invariants/verified-user-assertion-mounted.spec.ts:40",
        "libs/backend-common/src/auth/__tests__/jwt-verification.utils.spec.ts",
        "apps/gateway-api/src/guards/__tests__/auth.guard.spec.ts",
        "apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.spec.ts",
        "apps/admin-api-service/src/guards/__tests__/platform-admin.guard.spec.ts"
      ],
      "finding_id": "security-source-without-test:apps/hr-service/src/common/guards/gql-auth.guard.ts",
      "judge_id": "aria-evidence-judge",
      "judgment_group_id": null,
      "model": "claude-opus-5",
      "prompt_hash": null,
      "rationale": "WHAT THE FINDING CLAIMS: tools/aria-adapters/test-gap-adapter.ts:187-201 emits this finding when a file is security-sensitive (line 271: path contains .guard and text contains AuthGuard \u2014 both true here) and none of the four matchingTests criteria (lines 296-320) hit. I reproduced each criterion against the repository at e9b9d77. (1) Basename match anywhere (line 306): the only files named gql-auth* in the repository are apps/hr-service/src/common/guards/gql-auth.guard.ts and apps/farm-service/src/common/guards/gql-auth.guard.ts \u2014 both production, no spec or test. (2) Same-directory test (line 309): apps/hr-service/src/common/guards/ contains exactly one file, the guard. (3) <dir>/__tests__ (line 312): that directory does not exist. (4) Direct import from a test (line 315): no *.spec.ts or *.test.ts anywhere imports gql-auth.guard or references GqlAuthGuard; every importer is a production resolver \u2014 hr.resolver.ts:3/48, hr-finance.resolver.ts:27/73, leave.resolver.ts:21/83, training.resolver.ts:5/79, performance.resolver.ts:3/83, scheduling.resolver.ts:6/76, attendance.resolver.ts:20/70, aquaculture.resolver.ts:3/75. The 26 hr-service specs never call createNestApplication or overrideGuard and never send authorization/Bearer/x-user-payload headers or assert UnauthorizedException; the closest one, hr.resolver.employee-pii.spec.ts:49, constructs new HRResolver(commandBus, queryBus) directly, so the @UseGuards decorator is never evaluated and the guard body never runs. Under e2e/ the only hr-service reference is the schema-invariants spec. Tests that exist nearby cover something else: tests/invariants/no-dead-guards.spec.ts asserts the guard is wired somewhere (wiring, not behaviour); tests/invariants/verified-user-assertion-mounted.spec.ts:40 asserts hr-service mounts VerifiedUserAssertionMiddleware in the right order (middleware, not the guard); libs/backend-common/src/auth/__tests__/jwt-verification.utils.spec.ts covers getJwtVerifyOptions/enforceAccessTokenType, the helpers this guard delegates to at lines 143 and 148, not the guard's own branching. The repository convention for security guards is an adjacent spec \u2014 apps/gateway-api/src/guards/__tests__/auth.guard.spec.ts, apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.spec.ts, apps/admin-api-service/src/guards/__tests__/platform-admin.guard.spec.ts \u2014 so hr-service's guard is the outlier, not a different convention. Verdict: true_positive. WHY IT MATTERS: this guard is the resolver-level authentication control on every hr-service GraphQL resolver, in front of employee PII, payroll, leave, scheduling, training and HR finance data. Its untested branches are exactly the ones that regress silently: the HIGH-04 pre-authentication acceptance at gql-auth.guard.ts:116-127 admits a pre-set request.user only when sub, tenantId and a non-empty roles array are all present \u2014 if a future edit drops the roles.length > 0 condition, a minimal x-user-payload with only sub and tenantId would be accepted and no test would fail; the @Public bypass at 83-90; the REST fallback at 97-102; missing or non-Bearer token rejection at 131-133 and 166-182; verifyAsync bound to getJwtVerifyOptions at 141-144 and enforceAccessTokenType with the production flag at 147-148; the catch-all mapping to UnauthorizedException at 160-163; and the request.user/userId/tenantId attachment at 151-153 that downstream tenant scoping relies on. WHAT BREAKS IF SKIPPED: the guard stays a control that reviewers and the no-dead-guards invariant read as protection while nothing proves it rejects anything; a regression in any branch above ships to all eight resolvers unnoticed. WHAT TO DO (architectural tier 3, make it detectable): add apps/hr-service/src/common/guards/__tests__/gql-auth.guard.spec.ts following London-school style with mocked JwtService, ConfigService and Reflector, asserting every branch listed above including the negative pre-auth cases (roles absent, roles empty, sub or tenantId missing must fall through to the token path). Because apps/farm-service/src/common/guards/gql-auth.guard.ts is in the identical state, the class-level fix is an invariant under tests/invariants/ requiring every apps/**/*.guard.ts to have an adjacent or __tests__ spec (with a shrinking allowlist in the no-dead-guards style), so the next guard cannot be added untested. WHAT PROVES THE RESULT: the new spec sits in <dir>/__tests__ and imports the guard directly, satisfying adapter criteria 3 and 4 at test-gap-adapter.ts:312 and 315; npx nx affected --target=test passes with it; re-running the adapter no longer emits security-source-without-test:apps/hr-service/src/common/guards/gql-auth.guard.ts. CONFIDENCE AND LIMITS: 0.90. Searched scope: repository-wide filename glob for gql-auth*, directory listing of the guard's folder, content grep of every *.spec.ts for GqlAuthGuard/gql-auth.guard, grep of all ts/tsx/js/mjs for the hr-service guard path, behavioural grep of every hr-service spec for HTTP/guard markers, and grep of e2e/ and tests/ for hr-service auth coverage. Not executed: coverage tooling; a test that exercises the guard purely at runtime without importing or naming it would escape these searches, and I found no hr-service HTTP auth suite under e2e/ that could do so.",
      "run_id": null,
      "severity": "high",
      "tool_id": "test-gap-adapter",
      "verdict": "true_positive"
    }
  },
  "evidence_refs": [
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:71",
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:83",
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:97",
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:116",
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:131",
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:141",
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:148",
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:161",
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:166",
    "apps/hr-service/src/common/guards/gql-auth.guard.ts:177",
    "apps/hr-service/src/hr/hr.resolver.ts:3",
    "apps/hr-service/src/hr/hr.resolver.ts:48",
    "apps/hr-service/src/finance/resolvers/hr-finance.resolver.ts:73",
    "apps/hr-service/src/leave/leave.resolver.ts:83",
    "apps/hr-service/src/training/training.resolver.ts:79",
    "apps/hr-service/src/performance/performance.resolver.ts:83",
    "apps/hr-service/src/scheduling/scheduling.resolver.ts:76",
    "apps/hr-service/src/attendance/attendance.resolver.ts:70",
    "apps/hr-service/src/aquaculture/aquaculture.resolver.ts:75",
    "apps/hr-service/src/hr/__tests__/hr.resolver.employee-pii.spec.ts:10",
    "apps/hr-service/src/hr/__tests__/hr.resolver.employee-pii.spec.ts:49",
    "apps/farm-service/src/common/guards/gql-auth.guard.ts",
    "tools/aria-adapters/test-gap-adapter.ts:190",
    "tools/aria-adapters/test-gap-adapter.ts:257",
    "tools/aria-adapters/test-gap-adapter.ts:271",
    "tools/aria-adapters/test-gap-adapter.ts:296",
    "tools/aria-adapters/test-gap-adapter.ts:306",
    "tools/aria-adapters/test-gap-adapter.ts:309",
    "tools/aria-adapters/test-gap-adapter.ts:312",
    "tools/aria-adapters/test-gap-adapter.ts:315",
    "tools/aria-adapters/test-gap-adapter.ts:322",
    "tests/invariants/no-dead-guards.spec.ts:10",
    "tests/invariants/verified-user-assertion-mounted.spec.ts:40",
    "libs/backend-common/src/auth/__tests__/jwt-verification.utils.spec.ts",
    "apps/gateway-api/src/guards/__tests__/auth.guard.spec.ts",
    "apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.spec.ts",
    "apps/admin-api-service/src/guards/__tests__/platform-admin.guard.spec.ts",
    "aria-kernel/aria_kernel/evidence_validator.py:670",
    "tools/aria-poc/ci_executor.py:2519"
  ],
  "request_id": "AIR-aria-evidence-judge-a0bd4b0b5f2a",
  "role": "evidence_judgment",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:71",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:116",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:131",
        "apps/hr-service/src/common/guards/gql-auth.guard.ts:166",
        "apps/hr-service/src/hr/hr.resolver.ts:3",
        "apps/hr-service/src/hr/hr.resolver.ts:48",
        "apps/hr-service/src/hr/__tests__/hr.resolver.employee-pii.spec.ts:49",
        "tools/aria-adapters/test-gap-adapter.ts:296",
        "tools/aria-adapters/test-gap-adapter.ts:315"
      ],
      "id": "verdict",
      "note": "true_positive. The adapter's claim 'no adjacent or importing test coverage signal' reproduces against each of its four match criteria (tools/aria-adapters/test-gap-adapter.ts:296-320): (1) no test file with basename gql-auth exists anywhere in the repository \u2014 the only gql-auth* files are the hr-service and farm-service production guards; (2) apps/hr-service/src/common/guards/ contains only gql-auth.guard.ts; (3) no apps/hr-service/src/common/guards/__tests__/ directory exists; (4) no *.spec.ts or *.test.ts in the repository imports ../common/guards/gql-auth.guard or names GqlAuthGuard \u2014 every import of the guard is a production resolver (apps/hr-service/src/hr/hr.resolver.ts:3 plus seven sibling resolvers). The nearest test, apps/hr-service/src/hr/__tests__/hr.resolver.employee-pii.spec.ts:49, constructs HRResolver directly so the @UseGuards decorator at hr.resolver.ts:48 never executes. The security branches at gql-auth.guard.ts:83-90, 97-102, 116-127, 131-133, 141-148, 160-163 and 166-182 therefore have zero executing tests, while the guard is the active auth control on all eight hr-service GraphQL resolvers.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
