# syntax=docker/dockerfile:1.7
# =============================================================================
# new-aria operator console image
#
# WHY: the console projects ARIA's ledgers and delegates every action to the
# kernel CLI, so its runtime is the kernel image itself (same python, same
# /opt/new-aria tree, same non-root user) with the built console laid on top.
# The build stage is a plain node image so the SPA/server build never bloats
# the runtime layer.
# WHAT: stage 1 installs ui/ dependencies from the lockfile and builds server
# (tsc) + web (vite); stage 2 starts FROM the kernel image and copies dist/.
# Build context is new-aria/ (compose: `dockerfile: ui/Dockerfile`).
# =============================================================================
# Declared before the first FROM so the runtime stage's FROM can read it
# (an ARG inside a stage is invisible to a later FROM).
ARG BASE_IMAGE=new-aria:local
FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS build
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM ${BASE_IMAGE} AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=aria:aria /build/ui/package.json /opt/new-aria/ui/package.json
COPY --from=build --chown=aria:aria /build/ui/server/dist /opt/new-aria/ui/server/dist
COPY --from=build --chown=aria:aria /build/ui/web/dist /opt/new-aria/ui/web/dist
ENV ARIA_UI_STATIC_DIR=/opt/new-aria/ui/web/dist \
    ARIA_UI_PORT=8480 \
    ARIA_UI_HOST=0.0.0.0 \
    ARIA_KERNEL_BIN=/opt/new-aria/bin/aria
USER aria
EXPOSE 8480
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8480/api/v1/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/new-aria/ui/server/dist/server/src/index.js"]
