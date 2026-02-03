#!/bin/bash
# =============================================================================
# Local Development Script - FAST (No Docker build!)
#
# Usage: ./scripts/dev-local.sh [backend|frontend|all]
# =============================================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Aquaculture Platform - Local Development ===${NC}"

# Start infrastructure only (DB, Redis, NATS, MinIO)
echo -e "${YELLOW}Starting infrastructure containers...${NC}"
docker-compose -f docker-compose.infra.yml up -d

# Wait for services to be healthy
echo -e "${YELLOW}Waiting for infrastructure to be ready...${NC}"
sleep 5

# Check what to run
MODE=${1:-all}

case $MODE in
  backend)
    echo -e "${GREEN}Starting backend services with NX...${NC}"
    npx nx run-many -t serve --projects=gateway-api,auth-service,farm-service,sensor-service,alert-engine,hr-service,billing-service --parallel=4
    ;;
  frontend)
    echo -e "${GREEN}Starting frontend with NX...${NC}"
    npx nx serve shell
    ;;
  all)
    echo -e "${GREEN}Starting all services with NX...${NC}"
    # Backend in background, frontend in foreground
    npx nx run-many -t serve --projects=gateway-api,auth-service,farm-service,sensor-service,alert-engine,hr-service,billing-service --parallel=4 &
    BACKEND_PID=$!
    sleep 10
    npx nx serve shell
    # Cleanup on exit
    kill $BACKEND_PID 2>/dev/null
    ;;
  *)
    echo "Usage: $0 [backend|frontend|all]"
    exit 1
    ;;
esac
