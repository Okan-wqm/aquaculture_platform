# syntax=docker/dockerfile:1.7
# The semantic corpus Dockerfile: multi-stage, as production Dockerfiles are.
# DECOY: a commented FROM never runs.
# FROM registry.example/unused-floating:latest AS commented-out

# SAFE TWIN (floating_artifact): the build stage is digest-pinned. Its USER does not reach the
# final stage.
FROM node:22.12.0-alpine@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd AS build
USER node
RUN npm ci --omit=dev

# DECOY: a FROM and a USER inside a heredoc body are shell text, not instructions.
RUN <<SCRIPT
FROM evil:latest
USER root
SCRIPT

# UNSAFE TWINS (floating_artifact, privileged_runtime): the final base floats, and no USER
# drops root in the final stage.
FROM debian:bookworm-slim
COPY --from=build /app /app
CMD ["node", "/app/main.js"]
