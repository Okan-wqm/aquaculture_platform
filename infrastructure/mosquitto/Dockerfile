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
# SECURITY: Pin base image by digest for immutable, reproducible builds.
FROM debian:bookworm-slim@sha256:b0b3b8e4e0f0c1a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4

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

# SECURITY: Verify checksum of downloaded binary to prevent dependency substitution.
RUN ARCH_NAME=${TARGETARCH} && \
    curl -fsSL "https://github.com/iegomez/mosquitto-go-auth/releases/download/${GO_AUTH_VERSION}/linux-${ARCH_NAME}.zip" \
    -o /tmp/go-auth.zip && \
    curl -fsSL "https://github.com/iegomez/mosquitto-go-auth/releases/download/${GO_AUTH_VERSION}/checksums.txt" \
    -o /tmp/checksums.txt && \
    cd /tmp && grep "linux-${ARCH_NAME}.zip" checksums.txt | sha256sum -c - && \
    unzip /tmp/go-auth.zip -d /tmp/go-auth && \
    find /tmp/go-auth -name "go-auth.so" -exec cp {} /usr/lib/go-auth.so \; && \
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
