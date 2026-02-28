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
FROM eclipse-mosquitto:2.0.18

# Install mosquitto-go-auth plugin
ARG GO_AUTH_VERSION=2.1.0
ARG TARGETARCH=amd64

# Install required dependencies for the go-auth plugin
# NOTE: libcurl is kept because go-auth.so links against it at runtime
USER root
RUN apk add --no-cache curl libcurl && \
    ARCH_NAME=${TARGETARCH} && \
    curl -fsSL "https://github.com/iegomez/mosquitto-go-auth/releases/download/v${GO_AUTH_VERSION}/mosquitto-go-auth_${GO_AUTH_VERSION}_linux_${ARCH_NAME}.tar.gz" \
    -o /tmp/go-auth.tar.gz && \
    tar -xzf /tmp/go-auth.tar.gz -C /tmp/ && \
    cp /tmp/go-auth.so /mosquitto/go-auth.so && \
    rm -rf /tmp/go-auth*

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
