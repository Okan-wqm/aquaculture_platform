# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the sensor-ingestion sidecar.
#
# WHY a custom Dockerfile and not the platform `Dockerfile.backend`:
#   The NestJS Dockerfile.backend is multi-app shared, expects a node
#   runtime, and runs `node dist/...`. The Rust sidecar's runtime image
#   needs only libc + libssl3 + ca-certificates + the static binary.
#   Sharing the base would force the sidecar to lug a full node runtime
#   + npm cache for zero gain.
#
# WHY cargo-chef:
#   Splits the dep-build layer (rarely changes — keyed on Cargo.{toml,
#   lock}) from the source-build layer (changes per commit). Without it
#   every code edit re-downloads + re-compiles the full dep tree, which
#   for a tokio + rustls + tokio-postgres + rumqttc workspace is ~6 min
#   on the GHA runner.
#
# WHY debian:bookworm-slim runtime over scratch / distroless / alpine:
#   - tokio-postgres-rustls expects a working libc and access to
#     /etc/ssl/certs for the (rare) staging-broker fallback into Web-PKI.
#     distroless forces a bring-your-own CA story that adds operational
#     surface for no gain at this deploy scale.
#   - alpine = musl libc, which the workspace's tokio-postgres
#     vendored deps have not been audited against. Switching libc is
#     tracked work, not a stage-14 concern.
#   - bookworm-slim is what the rest of the platform's Rust deploys
#     (sens-api-gateway) target — uniform base = uniform CVE patching.
#
# WHY non-root uid 65532:
#   Same number used by Google distroless / Kubernetes nonroot image
#   convention. ADR-014/015 mandates least-privilege; the binary needs
#   no setuid capability and is started by the orchestrator.

# Stage 1 — chef: lock the cargo cache layer separately from sources.
FROM rust:1.88-slim AS chef
WORKDIR /build
RUN cargo install cargo-chef --locked

# Stage 2 — planner: emit recipe.json (cache key for deps).
FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY apps ./apps
COPY crates ./crates
RUN cargo chef prepare --recipe-path recipe.json

# Stage 3 — builder: cook deps then build the binary.
FROM chef AS builder
COPY --from=planner /build/recipe.json recipe.json
# WHY sources precede cook: the workspace patches rumqttc to a path
# dependency (crates/local-rumqttc, RUST-CVE-001). Reconstructing the
# dependency graph from the recipe needs every [patch.crates-io] target's
# manifest on disk, so the manifests + patched crate must be present before
# `cargo chef cook` — cooking with only recipe.json has failed on every
# release since the vendored fork landed. apps/ stays after cook so the
# dep layer stays keyed off manifests rather than application source.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo chef cook --release --recipe-path recipe.json --bin sensor-ingestion
# cook skeletonizes every manifest (including the root) to cook deps; its
# skeleton does not carry `[workspace.lints]`, so the real manifests and
# sources must be restored for the final build.
COPY Cargo.toml Cargo.lock ./
COPY apps ./apps
COPY crates ./crates
RUN cargo build --release --bin sensor-ingestion

# Stage 4 — runtime: minimal Debian slim with only what the binary needs.
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 65532 app \
 && useradd --system --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin app
COPY --from=builder /build/target/release/sensor-ingestion /usr/local/bin/sensor-ingestion
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/sensor-ingestion"]
