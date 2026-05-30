# ============================================
# Mosquitto with mosquitto-go-auth plugin
# Production image for HTTP-based authentication
# ============================================
#
# Build: docker build -t suderra/mosquitto-auth .
# Run: Use via docker-compose.droplet.yml
#
# This image adds the mosquitto-go-auth plugin to the official
# Eclipse Mosquitto image, enabling HTTP-based authentication
# against the sensor-service database.
#
# NOTE: Uses Debian-based image because mosquitto-go-auth (Go c-shared)
# is incompatible with Alpine's musl libc (golang/go#54805).
#
# Built only in GitHub Actions and deployed by immutable GHCR digest/tag.
FROM debian:bookworm-slim

# Install Mosquitto and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    mosquitto \
    curl \
    unzip \
    netcat-openbsd \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install mosquitto-go-auth plugin
ARG GO_AUTH_VERSION=3.0.0
ARG TARGETARCH=amd64
COPY go-auth-checksums.sha256 /tmp/go-auth-checksums.sha256

# SECURITY: Verify checksum of downloaded binary to prevent dependency substitution.
RUN set -eu; \
    ARCH_NAME="${TARGETARCH}"; \
    case "${ARCH_NAME}" in \
      amd64|arm64) ;; \
      *) echo "Unsupported TARGETARCH for mosquitto-go-auth: ${ARCH_NAME}" >&2; exit 1 ;; \
    esac; \
    GO_AUTH_SHA256="$(grep "  linux-${ARCH_NAME}.zip$" /tmp/go-auth-checksums.sha256 | cut -d' ' -f1)"; \
    test -n "${GO_AUTH_SHA256}"; \
    curl -fsSL "https://github.com/iegomez/mosquitto-go-auth/releases/download/${GO_AUTH_VERSION}/linux-${ARCH_NAME}.zip" \
    -o /tmp/go-auth.zip && \
    echo "${GO_AUTH_SHA256}  /tmp/go-auth.zip" | sha256sum -c - && \
    unzip /tmp/go-auth.zip -d /tmp/go-auth && \
    find /tmp/go-auth -name "go-auth.so" -exec cp {} /usr/lib/go-auth.so \; && \
    test -s /usr/lib/go-auth.so && \
    rm -rf /tmp/go-auth*

# Create mosquitto directories
RUN mkdir -p /mosquitto/config /mosquitto/data /mosquitto/log && \
    chown -R mosquitto:mosquitto /mosquitto

# Copy HTTP auth configuration
COPY mosquitto-production.conf /mosquitto/config/mosquitto.conf

# Ensure mosquitto user can modify config at runtime (entrypoint sed for secret injection)
RUN chown mosquitto:mosquitto /mosquitto/config/mosquitto.conf

USER mosquitto

# Healthcheck uses TCP check since allow_anonymous=false prevents unauthenticated pub
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD nc -z localhost 1883 || exit 1

EXPOSE 1883

CMD ["mosquitto", "-c", "/mosquitto/config/mosquitto.conf"]
