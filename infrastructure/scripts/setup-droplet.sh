#!/bin/bash
# =============================================================================
# Aquaculture Platform - DigitalOcean Droplet Setup Script
#
# Run this script on a fresh Ubuntu droplet:
#   curl -fsSL https://raw.githubusercontent.com/Okan-wqm/aquaculture_platform/main/infrastructure/scripts/setup-droplet.sh | bash
#
# Or manually:
#   chmod +x setup-droplet.sh && ./setup-droplet.sh
# =============================================================================

set -euo pipefail

REPO_URL="https://github.com/Okan-wqm/aquaculture_platform.git"
APP_DIR="/var/aqua-saas"

echo "============================================"
echo "  Aquaculture Platform - Droplet Setup"
echo "============================================"
echo ""

# --- 1. System Update ---
echo "[1/7] Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# --- 2. Install Docker ---
if command -v docker &> /dev/null; then
    echo "[2/7] Docker already installed: $(docker --version)"
else
    echo "[2/7] Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "Docker installed: $(docker --version)"
fi

# --- 3. Create Swap (important for 2GB RAM) ---
if [ -f /swapfile ]; then
    echo "[3/7] Swap already exists"
else
    echo "[3/7] Creating 2GB swap file..."
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    # Optimize swap behavior
    sysctl vm.swappiness=10
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
    echo "Swap configured: $(swapon --show)"
fi

# --- 4. Clone Repository ---
if [ -d "$APP_DIR/.git" ]; then
    echo "[4/7] Repository already cloned at $APP_DIR"
    cd "$APP_DIR"
    git pull origin main
else
    echo "[4/7] Cloning repository..."
    mkdir -p "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

# --- 5. Create .env file ---
if [ -f "$APP_DIR/.env" ]; then
    echo "[5/7] .env file already exists"
else
    echo "[5/7] Creating .env file from template..."
    cp "$APP_DIR/.env.production.example" "$APP_DIR/.env"

    # Generate random passwords
    POSTGRES_PW=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)
    REDIS_PW=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)
    JWT_SEC=$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 48)
    ENC_KEY=$(openssl rand -hex 16)

    sed -i "s/CHANGE_ME_strong_password_here/$POSTGRES_PW/" "$APP_DIR/.env"
    sed -i "s/CHANGE_ME_redis_password_here/$REDIS_PW/" "$APP_DIR/.env"
    sed -i "s/CHANGE_ME_minimum_32_chars_random_string/$JWT_SEC/" "$APP_DIR/.env"
    sed -i "s/CHANGE_ME_32_char_hex_string/$ENC_KEY/" "$APP_DIR/.env"

    echo ""
    echo "  Generated passwords saved to $APP_DIR/.env"
    echo "  IMPORTANT: Save these passwords somewhere safe!"
    echo ""
    cat "$APP_DIR/.env"
    echo ""
fi

# --- 6. Docker login to GHCR ---
echo "[6/7] Setting up GHCR access..."
echo ""
echo "  You need a GitHub Personal Access Token (PAT) with 'read:packages' scope."
echo "  Create one at: https://github.com/settings/tokens/new"
echo ""
echo "  Or add GHCR_TOKEN as a GitHub repository secret for automated deploys."
echo ""

if [ -t 0 ]; then
    read -p "  Enter your GitHub username: " GH_USER
    read -sp "  Enter your GitHub PAT (read:packages): " GH_TOKEN
    echo ""
    echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin
    echo "  GHCR login successful!"
else
    echo "  Skipping interactive login (non-interactive mode)"
    echo "  Run manually: docker login ghcr.io -u YOUR_USERNAME"
fi

# --- 7. First Deploy ---
echo "[7/7] Starting services..."
cd "$APP_DIR"
docker compose -f docker-compose.droplet.yml pull --ignore-pull-failures 2>/dev/null || echo "  Note: Images not yet available in GHCR. Push code to main to trigger first build."
docker compose -f docker-compose.droplet.yml up -d --remove-orphans 2>/dev/null || echo "  Note: Services will start after first successful CI/CD build."

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "  App directory:  $APP_DIR"
echo "  Compose file:   docker-compose.droplet.yml"
echo "  Env file:       $APP_DIR/.env"
echo ""
echo "  Next steps:"
echo "  1. Add GHCR_TOKEN secret to your GitHub repository"
echo "     (GitHub PAT with read:packages scope)"
echo "  2. Push code to main branch to trigger CI/CD"
echo "  3. Check status: docker compose -f docker-compose.droplet.yml ps"
echo "  4. View logs:    docker compose -f docker-compose.droplet.yml logs -f"
echo ""
echo "  Server IP: $(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo "  API URL:   http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):3000/graphql"
echo "  Web URL:   http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo ""
