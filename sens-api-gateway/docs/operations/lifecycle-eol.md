# Lifecycle & End-of-Life Policy — `sens-api-gateway`

**Audience:** Plant-IT planning, procurement, service-contract lawyer.

**Purpose:** declare the product lifecycle — version support bands, LTS (long-term-support) designation rule, deprecation-notice window, EOL policy, and the major-version migration template.

**Current release:** `v1.6.0` (2026-04-24).

---

## 1. Version scheme

Semantic versioning `MAJOR.MINOR.PATCH`.

- **MAJOR** — breaking change in a public contract: HTTP API shape, MQTT topic tree shape, command-envelope schema, on-disk keystore layout, event-contract shape where the edge is a producer.
- **MINOR** — new capability, backward-compatible wire formats, new protocol driver, new alert rule, new metric.
- **PATCH** — bug fix, security patch, hardening, perf tweak with no contract change.

Pre-release suffixes (`-alpha.N`, `-beta.N`, `-rc.N`) are allowed pre-GA; they are NOT production-supported.

---

## 2. LTS designation rule

**Rule: every 4th minor is an LTS release.** LTS releases receive 36-month support from their GA date.

| Branch | Non-LTS | LTS |
|--------|---------|-----|
| v1.0.x | — | LTS (first LTS, anchored at platform debut) |
| v1.1.x | 12-month support | — |
| v1.2.x | 12-month support | — |
| v1.3.x | 12-month support | — |
| v1.4.x | — | LTS |
| v1.5.x | 12-month | — |
| v1.6.x (current) | 12-month | — |
| v1.7.x | 12-month | — |
| v1.8.x (predicted) | — | **next LTS** |

"Support" = continues receiving security patches and SEV-1 / SEV-2 bug fixes. Non-LTS minors end support 12 months after GA. LTS minors end support 36 months after GA (see §4 for the EOL-tail policy).

---

## 3. Active / security-only / EOL bands

At any moment the active version set obeys an N, N-1, N-2, N-3 band rule:

| Band | Status | Patch content |
|------|--------|---------------|
| **N** (current) | Active | all fixes: security, bug, enhancement (within minor) |
| **N-1** | Active | all fixes: security, bug |
| **N-2** | Security-only | **only** CVE patches (critical + high) |
| **N-3** | **EOL** | no further patches; customers must upgrade |

**Applied to v1.6 as current:**

| Version | Band | Status | Support level |
|---------|------|--------|---------------|
| v1.6 | N | Active | all fixes |
| v1.5 | N-1 | Active | all fixes |
| v1.4 | N-2 (but also LTS) | **LTS Active** — LTS trumps N-2 | all fixes until LTS-end (GA + 36 mo), then security-only for 6 mo |
| v1.3 | N-3 | EOL | no patches |
| v1.0 (LTS) | N-6 in minor count, but LTS | LTS Active until GA + 36 mo | all fixes |

**Rule precedence:** when a version is both N-k (non-LTS band) and LTS, the **LTS band wins**. LTS support survives further than the N-1 / N-2 window.

---

## 4. EOL policy

### 4.1 Deprecation notice window

**Minimum 18 months** between formal EOL announcement and EOL effective date.

- Announcement is published in `docs/changelog/*` and in the customer-portal notification feed.
- Each announcement carries: affected version, EOL date, recommended upgrade path, estimated migration effort class (S / M / L / XL), co-migration support option per tier.

### 4.2 Security-patch tail after EOL

After EOL effective date, the version continues receiving **critical CVE patches for 6 additional months**. This is the EOL-tail and applies to LTS branches.

- Non-LTS versions: no EOL-tail; EOL is a hard stop.
- LTS versions: 6-month EOL-tail for critical-severity CVEs only.

### 4.3 Post-EOL support

After EOL-tail:

- Firmware images remain downloadable from the customer portal for record-keeping (not production use).
- No further patches. Customers running post-EOL firmware run at their own risk; the provider does not accept new SEV-1 tickets against post-EOL versions.
- Extended Support can be purchased as an annual subscription, scope-limited to critical CVEs, quoted per customer.

---

## 5. Deprecation notice lifecycle

```
Announcement  ───►  18 months  ───►  EOL-effective  ───►  6 months  ───►  Security-tail-end
    |                                      |                                      |
    |                                      |                                      |
    v                                      v                                      v
   All patches continue                  Non-LTS: hard stop                   No further patches
   Documented upgrade path available     LTS: 6-mo critical-CVE tail          Portal download remains
   Migration co-support per tier         Extended Support offer available
```

---

## 6. Migration guide template (major version bumps)

Every major bump ships a `docs/migration/vN-to-v(N+1).md` with these sections:

1. **Breaking changes** — exhaustive list with `before → after` snippets; schema diffs for the command-envelope / event contracts.
2. **Impact classification** — per-customer workload, S / M / L / XL migration effort.
3. **Pre-flight checklist** — config validator run, current-version health baseline capture, backup of the keystore + offline-queue WAL.
4. **Upgrade path** — blue/green recommended; staged rollout cohorts (canary → 10% → 50% → 100%); rollback trigger criteria.
5. **Compatibility matrix** — which N−1 minor versions can safely mixed-fleet with the new N+1 during transition.
6. **Validation suite** — acceptance test list; soak window (minimum 72 h on canary before phase-2 expansion).
7. **Rollback procedure** — time-bounded rollback window (typically 7 days after full rollout).
8. **FAQ** — expected-question list from support tickets during the previous migration.

---

## 7. Customer commitments on lifecycle

| Customer action | Commitment |
|-----------------|-----------|
| Upgrade off N-3 within band transition | customer-owned; provider sends 12-month, 6-month, 3-month, and 30-day reminders before EOL |
| Consume EOL-tail security patches | included in active support contract; no extra fee |
| Run post-EOL-tail firmware in production | customer-accepted risk; support tier degrades to "advisory only" for affected devices |

---

## 8. Provider commitments on lifecycle

1. **No silent EOL.** Every EOL requires the 18-month notice window.
2. **No last-minute schema changes** within a patch release. A `PATCH` cannot introduce a breaking wire-format change; that requires a MAJOR bump.
3. **LTS branches receive 36-month continuous support** from GA date, independent of subsequent release cadence.
4. **Migration support per support tier** (see [`support-tiers.md`](./support-tiers.md) §3).
5. **Public release notes** for every release with CVE-patch enumeration and wire-format diff summary.

---

## 9. Release cadence expectation (non-contractual)

- Minor releases: target quarterly.
- Patch releases: as needed; target monthly at minimum during the support band.
- Security-emergency patches: out-of-band; SLA per severity in [`support-tiers.md`](./support-tiers.md) §3.

These cadences are expectations, not commitments — the commitment is the support band in §3 and the EOL-notice in §4.

---

## 10. Evidence & open items

- `Cargo.toml:3` — `version = "1.6.0"`.
- `Cargo.toml:5` — `rust-version = "1.85"`.
- Open: the "every 4th minor = LTS" rule is a committed policy from v1.6.0 forward. The back-application to v1.0 as the first LTS requires confirmation from the release manager. Owner: release-manager. Target: v1.7.0 release notes.
- Open: `docs/migration/v1-to-v2.md` template skeleton — to be instantiated when a v2 branch is opened.
- Open: Extended Support pricing and scope definition — `{TEMPLATE}` in the MSA annex. Owner: commercial-legal-writer.
