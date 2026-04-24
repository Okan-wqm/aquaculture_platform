# Software Bill of Materials (SBOM) Policy — `sens-api-gateway` v1.6.0

**Source of truth:** HEAD `3413db47`, tag `v1.6.0`, date `2026-04-24`.
**Standard:** OWASP CycloneDX 1.5; supports SPDX export on request.

---

## 1. Policy

Every released binary of `suderra-agent` ships with a machine-readable SBOM. The SBOM is generated at build time from the `Cargo.lock` universe of pinned dependencies and signed by the release pipeline's slot-6 (license/program-signing) Ed25519 key.

Three production artifacts per release:

1. **Source SBOM (`sbom-source.cdx.json`)** — CycloneDX output of `cargo cyclonedx --format json --all`. Lists every crate in the dependency graph.
2. **Binary SBOM (`sbom-binary.cdx.json`)** — CycloneDX extracted from the binary via `cargo auditable build` + `cargo audit bin`. Reflects what actually landed in the compiled artifact (feature-gated crates disabled here if the feature was off at build time).
3. **Third-party license manifest (`NOTICES.txt`)** — `cargo-about generate` output against `about.toml` policy.

---

## 2. Generation

```bash
# Source SBOM (CycloneDX)
cargo install cargo-cyclonedx --locked
cd sens-api-gateway
cargo cyclonedx --format json --all --output-pattern sbom-source

# Binary SBOM (cargo-auditable)
cargo install cargo-auditable cargo-audit --locked
RUSTFLAGS='' cargo auditable build --release --target aarch64-unknown-linux-gnu
cargo audit bin target/aarch64-unknown-linux-gnu/release/suderra-agent --json > sbom-binary.cdx.json

# License manifest
cargo install cargo-about --locked
cargo about generate about.hbs > NOTICES.txt
```

Each step is idempotent and wired into the CI release job (`.github/workflows/edge-release.yml` — cross-references the edge-release workflow).

---

## 3. Distribution

- **GitHub release artifacts** — all three files attached to each GitHub release tag matching `sens-api-gateway-v*`.
- **In-binary query** — `cargo auditable build` embeds a compressed SBOM in an ELF `.audit` section of the binary. Operators can extract in-field with `cargo audit bin /usr/bin/suderra-agent`.
- **Customer portal** — signed SBOM bundle (`sbom.zip.sig`) uploaded to the partner-onboarding portal for Siemens-grade supplier-assessment workflows.
- **PURL-identified components** — every entry in the CycloneDX file carries a `purl` (Package URL) to ease downstream vulnerability correlation.

---

## 4. Retention

SBOMs for every released tag are retained **7 years** to match SOC 2 evidence retention and ISO/IEC 27001 supplier-management requirements.

Storage: S3-equivalent object store with object-lock (write-once-read-many); one bucket per year; bucket-level retention policy pinned at 2555 days.

---

## 5. Today status

SBOM generation is **NOT YET WIRED** into the automated release pipeline. Root-cause: release workflow (`edge-release.yml`) currently emits only the cross-compiled binary tarball. The three-file bundle above is a tracked SUPPLY-HIGH-003 finding with owner `release-engineering` and target ROADMAP-Q3 2026.

The blocker is not technical — all four tools (`cargo-cyclonedx`, `cargo-auditable`, `cargo-audit`, `cargo-about`) build cleanly against the current toolchain. The gap is purely release-automation wiring.

Until wiring lands, SBOM generation is available on-demand by the release engineer running the commands in §2 against a clean `Cargo.lock` checkout.

---

## 6. Required policy fields

Every CycloneDX entry must carry:

- `name`, `version` (crate name + semver)
- `purl` (Package URL, e.g. `pkg:cargo/ed25519-dalek@2.1.0`)
- `licenses[].license.id` (SPDX identifier; `BSD-3-Clause`, `MIT`, `Apache-2.0`, etc.)
- `hashes[]` (SHA-256 of the crate source as recorded in `Cargo.lock`)
- `supplier.name` where known

Critical-path crypto crates additionally carry:

- `externalReferences` to upstream RustSec advisory indexes.
- `evidence.identity.confidence` (`high` for direct dependencies, `medium` for transitive-only).

---

## 7. Vulnerability correlation path

The release workflow runs `cargo audit --json` against the generated `Cargo.lock` before artifact publication. Any advisory of severity CRITICAL or HIGH blocks the release; MEDIUM emits a warning and must be triaged within 7 days per `cvd-policy.md`.

`cargo-deny` also runs with `deny.toml` (present at `sens-api-gateway/deny.toml`) to enforce:

- Dual-license compatibility (GPL excluded)
- Yanked-crate rejection
- Duplicated-dependency rejection (strict)

---

## 8. Exported-binary specifics

The release binary is stripped (`Cargo.toml:426` `strip = true`) and the `.audit` ELF section survives strip because `cargo auditable` places it in a SHF_ALLOC-free section. Operators who need to verify SBOM on a deployed edge device:

```bash
cargo audit bin /usr/bin/suderra-agent
# or: readelf -p .dep-v0 /usr/bin/suderra-agent | jq .
```

---

## 9. Customer delivery formats

- CycloneDX JSON (default).
- CycloneDX XML on request.
- SPDX 2.3 on request — converted via `cyclonedx-convert`.
- CSV pivot for non-security procurement teams who want a quick-view license inventory.

---

## 10. Today-vs-roadmap truth line

| Item | Today | Target |
|------|-------|--------|
| CycloneDX source SBOM | Manual (on-demand) | ROADMAP-Q3 auto in release CI |
| CycloneDX binary SBOM | Not generated | ROADMAP-Q3 |
| `.audit` ELF section | Not emitted (`cargo build` not `cargo auditable build`) | ROADMAP-Q3 |
| Signed SBOM bundle | Not signed | ROADMAP-Q3 |
| 7-year retention store | Not set up | ROADMAP-Q3 |

SUPPLY-HIGH-003 tracks all five items in a single finding; owner release-engineering; target ROADMAP-Q3.

---

## 11. Cross-references

- `cvd-policy.md` — vulnerability-handling SLAs that depend on SBOM accuracy.
- `commercial/licensing.md` (produced by commercial-legal-writer) — proprietary vs OSS license model.
- `deny.toml` at `sens-api-gateway/deny.toml` — cargo-deny policy that feeds the SBOM pipeline.
