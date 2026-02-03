# =============================================================================
# Local Development Script - FAST (No Docker build!)
#
# Usage: .\scripts\dev-local.ps1 [-Mode backend|frontend|all]
# =============================================================================

param(
    [ValidateSet("backend", "frontend", "all")]
    [string]$Mode = "all"
)

$ErrorActionPreference = "Stop"

Write-Host "=== Aquaculture Platform - Local Development ===" -ForegroundColor Green

# Start infrastructure only (DB, Redis, NATS, MinIO)
Write-Host "Starting infrastructure containers..." -ForegroundColor Yellow
docker-compose -f docker-compose.infra.yml up -d

# Wait for services to be healthy
Write-Host "Waiting for infrastructure to be ready..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

switch ($Mode) {
    "backend" {
        Write-Host "Starting backend services with NX..." -ForegroundColor Green
        npx nx run-many -t serve --projects=gateway-api,auth-service,farm-service,sensor-service,alert-engine,hr-service,billing-service --parallel=4
    }
    "frontend" {
        Write-Host "Starting frontend with NX..." -ForegroundColor Green
        npx nx serve shell
    }
    "all" {
        Write-Host "Starting all services with NX..." -ForegroundColor Green
        # Start backend in new terminal
        Start-Process powershell -ArgumentList "-Command", "npx nx run-many -t serve --projects=gateway-api,auth-service,farm-service,sensor-service,alert-engine,hr-service,billing-service --parallel=4"
        Start-Sleep -Seconds 10
        # Frontend in current terminal
        npx nx serve shell
    }
}
