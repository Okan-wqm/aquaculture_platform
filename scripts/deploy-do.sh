#!/bin/bash
# =============================================================================
# Digital Ocean Deployment Script - FAST (Pull pre-built images, NO rebuild!)
#
# Prerequisites:
# 1. Push code to GitHub main branch
# 2. Wait for GitHub Actions to build images (~10-15 min)
# 3. Run this script on your DO droplet
#
# Usage: ./scripts/deploy-do.sh
# =============================================================================

set -e

REGISTRY="ghcr.io"
REPO="your-username/aquaculture-platform"  # Update this!
TAG="latest"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== Digital Ocean Deployment (Fast - Pull Only) ===${NC}"

# Check if logged in to GitHub Container Registry
if ! docker info 2>/dev/null | grep -q "ghcr.io"; then
    echo -e "${YELLOW}Logging in to GitHub Container Registry...${NC}"
    echo "Please enter your GitHub Personal Access Token (with read:packages scope):"
    read -s GITHUB_TOKEN
    echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin
fi

# Navigate to project directory
cd /var/aqua-saas || { echo -e "${RED}Project directory not found!${NC}"; exit 1; }

# Pull latest images (NO BUILD!)
echo -e "${YELLOW}Pulling latest images from GitHub Container Registry...${NC}"
docker-compose -f docker-compose.prod.yml pull

# Rolling update with zero downtime
echo -e "${YELLOW}Starting rolling update...${NC}"
docker-compose -f docker-compose.prod.yml up -d --no-build --remove-orphans

# Wait for services
echo -e "${YELLOW}Waiting for services to be healthy...${NC}"
sleep 30

# Health check
if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "${GREEN}Deployment successful!${NC}"
else
    echo -e "${YELLOW}Health check endpoint not responding, checking containers...${NC}"
    docker-compose -f docker-compose.prod.yml ps
fi

# Cleanup old images
echo -e "${YELLOW}Cleaning up old images...${NC}"
docker image prune -f --filter "until=24h"

echo -e "${GREEN}=== Deployment completed at $(date) ===${NC}"
