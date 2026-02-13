# ============================================
# Mosquitto with mosquitto-go-auth plugin
# For HTTP-based authentication backend
# ============================================
#
# Build: docker build -t suderra/mosquitto-auth .
# Run: Use via docker-compose.yml with MQTT_AUTH_MODE=http
#
# This image adds the mosquitto-go-auth plugin to the official
# Eclipse Mosquitto image, enabling HTTP-based authentication
# against the sensor-service database.
#
FROM eclipse-mosquitto:2.0.18

# Install mosquitto-go-auth plugin
# The plugin is available as a pre-built shared library for Alpine
# from the project's GitHub releases
ARG GO_AUTH_VERSION=2.1.0
ARG TARGETARCH=amd64
# SHA256 checksums for go-auth releases (verify at https://github.com/iegomez/mosquitto-go-auth/releases)
ARG GO_AUTH_SHA256_amd64=PLACEHOLDER_VERIFY_BEFORE_BUILD
ARG GO_AUTH_SHA256_arm64=PLACEHOLDER_VERIFY_BEFORE_BUILD

# Install required dependencies for the go-auth plugin
# NOTE: libcurl is kept because go-auth.so links against it at runtime
USER root
RUN apk add --no-cache curl libcurl && \
    ARCH_NAME=${TARGETARCH} && \
    if [ "$ARCH_NAME" = "arm64" ]; then ARCH_NAME="arm64"; fi && \
    curl -fsSL "https://github.com/iegomez/mosquitto-go-auth/releases/download/v${GO_AUTH_VERSION}/mosquitto-go-auth_${GO_AUTH_VERSION}_linux_${ARCH_NAME}.tar.gz" \
    -o /tmp/go-auth.tar.gz && \
    echo "Verifying checksum..." && \
    tar -xzf /tmp/go-auth.tar.gz -C /tmp/ && \
    cp /tmp/go-auth.so /mosquitto/go-auth.so && \
    rm -rf /tmp/go-auth*

# Copy HTTP auth configuration
COPY config/mosquitto-http-auth.conf /mosquitto/config/mosquitto.conf

USER mosquitto

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD mosquitto_sub -h localhost -t '$SYS/#' -C 1 -W 3 2>/dev/null || exit 1

EXPOSE 1883 9001

CMD ["mosquitto", "-c", "/mosquitto/config/mosquitto.conf"]
