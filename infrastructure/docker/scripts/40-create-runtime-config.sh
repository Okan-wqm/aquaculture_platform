#!/bin/sh
# =============================================================================
# Shell App - Runtime Configuration Script
# ARCH-011: Proper script file replaces fragile echo-chain RUN instruction.
# Nginx containers execute scripts in /docker-entrypoint.d/ on startup,
# so environment variables set in the compose file are available here.
# =============================================================================

cat > /usr/share/nginx/html/config.js << EOF
window.__REMOTE_URLS__ = {
  dashboard: "${DASHBOARD_URL}",
  farmModule: "${FARM_MODULE_URL}",
  processEditor: "${PROCESS_EDITOR_URL}",
  adminPanel: "${ADMIN_PANEL_URL}",
  hrModule: "${HR_MODULE_URL}",
  sensorModule: "${SENSOR_MODULE_URL}",
  hydroponicsModule: "${HYDROPONICS_MODULE_URL}",
  tenantAdmin: "${TENANT_ADMIN_URL}"
};
EOF
