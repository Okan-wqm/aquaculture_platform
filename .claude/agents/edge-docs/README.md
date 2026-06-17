# Edge-Docs Agent Team — Siemens-Ready Product Documentation

**Mission:** Produce enterprise-grade, Siemens-vendor-assessment-ready documentation for `sens-api-gateway` (Rust industrial edge gateway, v1.6.0+). Output is the deliverable package a Siemens procurement + OT cyber-security reviewer would receive as part of a PROFINET / MindSphere / TIA Portal partnership evaluation or a supplier cyber-security questionnaire (CSQ).

**Lane:** Lane-C — documentation-production (distinct from Lane-A code-review and Lane-B product-audit). Lane-C agents WRITE only to `sens-api-gateway/docs/**`. `sensorprotocols/**`, root `docs/**`, source code, configs, and prompts are read-only evidence inputs; they do NOT review or edit application code.

**Dispatcher:** `edge-docs-orchestrator` — the single entry point. Users invoke the orchestrator, which analyses which deliverable is requested (full RFP package / single chapter / delta update) and dispatches the right producers in parallel. Producer agents do not fan out to each other.

## Roster

| Agent | Deliverable scope |
|-------|-------------------|
| `edge-docs-orchestrator` | Coordinates + consolidates; produces top-level `docs/README.md` + `docs/index.md` |
| `product-overview-writer` | Executive summary, positioning vs MindConnect Nano / Greengrass / FlexEdge, feature matrix, use-case catalogue |
| `architecture-writer` | C4 model (context/container/component/code), deployment topology, data-flow diagrams, ADR registry index |
| `protocol-reference-writer` | Normative reference per wire protocol (Modbus-TCP/RTU, OPC UA, S7comm, EtherNet/IP, ADS, Codesys, LoRaWAN, MQTT, I2C, SPI, PWM, GPIO, Atlas EZO) — AsyncAPI/NodeSet/GSDML-grade |
| `security-architecture-writer` | Threat model (STRIDE), crypto inventory, PKI hierarchy, secure-boot path, SBOM, CVD policy (ISO/IEC 30111), attack surface analysis |
| `compliance-evidence-writer` | IEC 62443-4-1 SDLA evidence, IEC 62443-4-2 FR1-FR7 gap tables, IEC 61131-3 language coverage, ISA-18.2 alarm KPIs, CE/UL/FCC/RED mapping, GDPR/KVKK DPIA |
| `deployment-runbook-writer` | Install guide, provisioning runbook, OTA firmware update, backup/restore, disaster recovery, air-gapped install, DMZ topology |
| `siemens-integration-writer` | Siemens-specific: TIA Portal GSDML export, S7 area-code mapping, MindSphere / Insights Hub connector, WinCC tag bridge, PROFINET IRT readiness |
| `operations-sla-writer` | MTBF/MTTR targets, availability SLA, observability SLA (metric cardinality, log volume), monitoring runbook, alert rule catalogue, support tier matrix |
| `test-evidence-writer` | Test strategy, unit/integration/HIL coverage report, regression suite, soak/endurance protocol (1000h), EMC compliance plan (IEC 60068, IEC 61000-4) |
| `api-reference-writer` | Rust API (cargo doc), HTTP API (OpenAPI 3.1), MQTT topic tree (AsyncAPI 2.6), CLI command reference, RBAC permission manifest |
| `commercial-legal-writer` | License model (proprietary + OSS attribution), source-code escrow clause, indemnification boilerplate, export-control ECCN classification, data-residency policy |
| `siemens-rfp-responder` | Siemens-specific deliverables: Vendor Assessment Questionnaire (VAQ), Cyber Security Questionnaire (CSQ), PROFINET Conformance Class declaration, MindSphere readiness checklist |

## Output Tree

All producers WRITE under `sens-api-gateway/docs/` using the following canonical layout. No producer creates top-level files outside this tree:

```
sens-api-gateway/docs/
├── README.md                    # owned by edge-docs-orchestrator
├── index.md                     # owned by edge-docs-orchestrator
├── product/                     # product-overview-writer
├── architecture/                # architecture-writer
├── protocols/                   # protocol-reference-writer (one file per protocol)
├── security/                    # security-architecture-writer
├── compliance/                  # compliance-evidence-writer
├── deployment/                  # deployment-runbook-writer
├── integration/siemens/         # siemens-integration-writer
├── operations/                  # operations-sla-writer
├── testing/                     # test-evidence-writer
├── api/                         # api-reference-writer
├── commercial/                  # commercial-legal-writer
└── siemens-rfp/                 # siemens-rfp-responder
```

## Banned-phrase discipline (CLAUDE.md Architectural Approach)

Every chapter MUST avoid the CLAUDE.md banned phrases except with the documented qualifiers. Substitutes:

| Banned | Replace with |
|--------|--------------|
| "for now" / "temporary" | "time-bounded" / "finite-duration" (with TTL or owner) |
| "interim hardening" / "interim frame" | "initial hardening" / "intermediate frame" |
| "pragmatic" / "simpler approach" / "middle ground" | justify with ADR / finding ID or rewrite |
| "deferred" (bare) | "ROADMAP-QX + finding ID" / "HARDWARE-VENDOR RESPONSIBILITY (owner, deadline)" |
| "out of scope" (bare) | "Not covered by this doc — see `<ref>`" / "handled in `<other-doc>`" |
| "good enough" / "sufficient for now" | rewrite with specific acceptance criterion |

Pre-commit hook (`tools/gates/banned-phrase.ts`) enforces this at commit time. Fix the text, never `--no-verify`.

## Invocation Contract

- **Never** invoke a Lane-C producer directly for new work — go through `edge-docs-orchestrator`. Direct invocation is allowed only when REGENERATING a single existing chapter after a source-of-truth change.
- Do not install dependencies, modify lockfiles/manifests, run network fetches, or write outside `sens-api-gateway/docs/**`. Lane-C is doc-production only.
- Every producer verifies claims against the live repo (code, Cargo.toml, ADRs, existing `docs/adr/`, `sensorprotocols/`) before writing. **No hallucinated feature is allowed** — if a feature doesn't exist yet, the doc labels it ROADMAP with an estimated milestone, not PRESENT.
- Every chapter cites its evidence: `src/file.rs:line`, `Cargo.toml:line`, ADR ID. Un-cited claims are a review defect.
- Turkish OR English both acceptable per chapter; default English for Siemens-facing deliverables (`siemens-rfp/**`, `integration/siemens/**`). Internal-facing can be Turkish if shorter.

## Quality Gates

- Every producer's output passes a `markdownlint` + link-check + "no-hallucination" validation (every cited `src/*.rs:N` must resolve to an existing file and line).
- Pre-commit `banned-phrase.ts` must pass (see table above).
- CI gate candidates (not yet wired): `tests/invariants/edge-docs-evidence-links.spec.ts` — greps every `src/...:NN` anchor in `sens-api-gateway/docs/**` and asserts file + line exist.
- Release gate: before a new `sens-api-gateway` version tag, `edge-docs-orchestrator` runs a "doc-drift" pass asserting every public API surface has a corresponding chapter section.

## Non-goals

- NOT a code reviewer. Lane-A `edge-expert` + Lane-B `product-audit` own that.
- NOT a test writer. `test-evidence-writer` documents tests that EXIST; it does not author new Rust tests.
- NOT a sales pitch generator. Marketing collateral is out of scope of Lane-C; factual product documentation only (see `commercial-legal-writer` for the commercial-template half).
