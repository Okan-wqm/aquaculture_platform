# Edge Device Provisioning - Implementation Plan


**Goal:** Enable zero-touch edge device provisioning with DB-backed configuration, CI/CD for Rust binary releases, and admin panel settings management.

**Architecture:** The provisioning system already exists (ProvisioningService, ProvisioningController, Rust agent). This plan adds: (1) GitHub Actions CI/CD for cross-compiling the Rust agent, (2) DB-backed provisioning settings replacing env vars, (3) admin panel UI for managing those settings, (4) SHA256 checksum verification in the installer script.

**Tech Stack:** NestJS (backend), GitHub Actions + `cross` (CI/CD), React/TypeScript (frontend), Rust (edge agent)

**Design Doc:** `docs/plans/2026-02-13-edge-device-provisioning-design.md`

---

## Task 1: GitHub Actions CI/CD Workflow for Rust Agent

**Files:**
- Create: `.github/workflows/edge-agent-release.yml`
- Reference: `sens-api-gateway/Cargo.toml` (project name: `suderra-edge-agent`, version: `1.3.0`)

**Step 1: Create the workflow file**

```yaml
# .github/workflows/edge-agent-release.yml
name: Edge Agent Release

on:
  push:
    tags:
      - 'agent-v*'  # e.g., agent-v1.3.0

env:
  CARGO_TERM_COLOR: always
  BINARY_NAME: suderra-agent

jobs:
  build:
    name: Build ${{ matrix.target }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - target: x86_64-unknown-linux-gnu
            archive: suderra-agent-x86_64-linux
          - target: aarch64-unknown-linux-gnu
            archive: suderra-agent-aarch64-linux
          - target: armv7-unknown-linux-gnueabihf
            archive: suderra-agent-armv7-linux

    steps:
      - uses: actions/checkout@v4

      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Install cross
        run: cargo install cross --git https://github.com/cross-rs/cross

      - name: Build release binary
        working-directory: sens-api-gateway
        run: cross build --release --target ${{ matrix.target }}

      - name: Strip binary
        run: |
          if [ "${{ matrix.target }}" = "x86_64-unknown-linux-gnu" ]; then
            strip sens-api-gateway/target/${{ matrix.target }}/release/suderra-edge-agent
          fi

      - name: Package binary
        run: |
          VERSION=${GITHUB_REF_NAME#agent-}
          ARCHIVE="${{ matrix.archive }}"
          mkdir -p dist
          cp sens-api-gateway/target/${{ matrix.target }}/release/suderra-edge-agent dist/edge-agent
          cd dist
          tar -czf "../${ARCHIVE}.tar.gz" edge-agent
          cd ..
          sha256sum "${ARCHIVE}.tar.gz" > "${ARCHIVE}.tar.gz.sha256"

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.archive }}
          path: |
            *.tar.gz
            *.tar.gz.sha256

  release:
    name: Create Release
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          merge-multiple: true

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          name: "Edge Agent ${{ github.ref_name }}"
          body: |
            ## Suderra Edge Agent ${{ github.ref_name }}

            ### Downloads
            | Platform | Architecture | File |
            |----------|-------------|------|
            | Linux | x86_64 (Intel/AMD) | `suderra-agent-x86_64-linux.tar.gz` |
            | Linux | aarch64 (RPi 4/5, RevPi) | `suderra-agent-aarch64-linux.tar.gz` |
            | Linux | armv7 (RPi 3) | `suderra-agent-armv7-linux.tar.gz` |

            SHA256 checksums are provided alongside each archive.
          files: |
            *.tar.gz
            *.tar.gz.sha256
          draft: false
          prerelease: false
```

**Step 2: Verify workflow syntax**

Run: `cd /c/Users/Okn/.claude-worktrees/aquaculture-platform/infallible-cohen && cat .github/workflows/edge-agent-release.yml | head -5`
Expected: Shows the workflow header

**Step 3: Commit**

```bash
git add .github/workflows/edge-agent-release.yml
git commit -m "ci: add GitHub Actions workflow for edge agent cross-compile releases"
```

---

## Task 2: Add Provisioning Settings to Admin API (GlobalConfig)

**Context:** The `GlobalSettingsService` in admin-api-service manages `GlobalConfig` entities (key-value with categories and history tracking). We'll use this pattern to store provisioning configuration instead of env vars.

**Files:**
- Modify: `apps/admin-api-service/src/system-management/services/global-settings.service.ts` (add provisioning config getter)
- Modify: `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts` (add provisioning endpoints)
- Reference: `apps/admin-api-service/src/system-management/entities/global-config.entity.ts` (GlobalConfig entity with ConfigCategory enum)

**Step 1: Add PROVISIONING category to ConfigCategory enum**

File: `apps/admin-api-service/src/system-management/entities/global-config.entity.ts`

Find the `ConfigCategory` enum and add `PROVISIONING = 'provisioning'` entry.

**Step 2: Add provisioning config methods to GlobalSettingsService**

File: `apps/admin-api-service/src/system-management/services/global-settings.service.ts`

Add these methods:

```typescript
/**
 * Get provisioning configuration
 * Used by sensor-service to generate installer scripts
 */
async getProvisioningConfig(): Promise<{
  provisioningApiUrl: string;
  mqttBrokerHost: string;
  mqttBrokerPort: number;
  githubReleaseUrl: string;
  agentDefaultVersion: string;
  githubRepo: string;
}> {
  const defaults = {
    'provisioning.api_url': 'http://localhost:3000',
    'provisioning.mqtt_broker_host': 'localhost',
    'provisioning.mqtt_broker_port': '1883',
    'provisioning.github_release_url': 'https://github.com/Okan-wqm/sens/releases',
    'provisioning.agent_default_version': 'latest',
    'provisioning.github_repo': 'Okan-wqm/sens',
  };

  const configs = await this.configRepo.find({
    where: { category: ConfigCategory.PROVISIONING, isActive: true },
  });

  const getValue = (key: string): string => {
    const config = configs.find(c => c.key === key);
    return config?.value ?? defaults[key] ?? '';
  };

  return {
    provisioningApiUrl: getValue('provisioning.api_url'),
    mqttBrokerHost: getValue('provisioning.mqtt_broker_host'),
    mqttBrokerPort: parseInt(getValue('provisioning.mqtt_broker_port'), 10),
    githubReleaseUrl: getValue('provisioning.github_release_url'),
    agentDefaultVersion: getValue('provisioning.agent_default_version'),
    githubRepo: getValue('provisioning.github_repo'),
  };
}

/**
 * Update provisioning configuration
 */
async updateProvisioningConfig(
  updates: Record<string, string>,
  updatedBy: string,
): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    const fullKey = key.startsWith('provisioning.') ? key : `provisioning.${key}`;
    let config = await this.configRepo.findOne({ where: { key: fullKey } });

    if (config) {
      await this.updateConfig(config.id, value, updatedBy);
    } else {
      await this.createConfig({
        key: fullKey,
        value,
        category: ConfigCategory.PROVISIONING,
        description: `Provisioning setting: ${key}`,
        valueType: ConfigValueType.STRING,
        isActive: true,
      });
    }
  }
}
```

**Step 3: Add provisioning endpoints to controller**

File: `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts`

Add endpoints:

```typescript
@Get('provisioning-config')
async getProvisioningConfig() {
  return this.globalSettingsService.getProvisioningConfig();
}

@Put('provisioning-config')
async updateProvisioningConfig(
  @Body() body: Record<string, string>,
  @Req() req: any,
) {
  const userId = req.user?.id || 'system';
  await this.globalSettingsService.updateProvisioningConfig(body, userId);
  return { success: true };
}
```

**Step 4: Commit**

```bash
git add apps/admin-api-service/src/system-management/
git commit -m "feat: add provisioning config management to admin API global settings"
```

---

## Task 3: Update ProvisioningService to Read Config from Admin API

**Context:** Currently `ProvisioningService` reads config from env vars in constructor (lines 61-65). We need to make it read from admin API's GlobalConfig at runtime, with env vars as fallback.

**Files:**
- Modify: `apps/sensor-service/src/edge-device/provisioning.service.ts`

**Step 1: Add HTTP client to fetch provisioning config from admin API**

Replace the hardcoded constructor config with a method that fetches from admin API:

```typescript
// In constructor, change from:
this.API_BASE_URL = this.configService.get<string>('PROVISIONING_API_BASE_URL', 'http://localhost:3000');
// etc.

// To: Keep env vars as defaults, add a method to fetch from admin API
private cachedConfig: ProvisioningConfig | null = null;
private configCacheExpiry: Date = new Date(0);
private readonly CONFIG_CACHE_TTL_MS = 60000; // 1 minute

async getProvisioningConfig(): Promise<ProvisioningConfig> {
  if (this.cachedConfig && this.configCacheExpiry > new Date()) {
    return this.cachedConfig;
  }

  try {
    const adminApiUrl = this.configService.get<string>('ADMIN_API_URL', 'http://localhost:3010');
    const response = await fetch(`${adminApiUrl}/system-management/provisioning-config`);

    if (response.ok) {
      const config = await response.json();
      this.cachedConfig = {
        apiBaseUrl: config.provisioningApiUrl || this.API_BASE_URL,
        mqttBroker: config.mqttBrokerHost || this.MQTT_BROKER,
        mqttPort: config.mqttBrokerPort || this.MQTT_PORT,
        agentVersion: config.agentDefaultVersion || this.AGENT_VERSION,
        githubRepo: config.githubRepo || this.configService.get('EDGE_AGENT_GITHUB_REPO', 'Okan-wqm/sens'),
        githubReleaseUrl: config.githubReleaseUrl || `https://github.com/Okan-wqm/sens/releases`,
      };
      this.configCacheExpiry = new Date(Date.now() + this.CONFIG_CACHE_TTL_MS);
      return this.cachedConfig;
    }
  } catch (error) {
    this.logger.warn('Failed to fetch provisioning config from admin API, using env defaults', error.message);
  }

  // Fallback to env vars
  return {
    apiBaseUrl: this.API_BASE_URL,
    mqttBroker: this.MQTT_BROKER,
    mqttPort: this.MQTT_PORT,
    agentVersion: this.AGENT_VERSION,
    githubRepo: this.configService.get('EDGE_AGENT_GITHUB_REPO', 'Okan-wqm/sens'),
    githubReleaseUrl: `https://github.com/Okan-wqm/sens/releases`,
  };
}

interface ProvisioningConfig {
  apiBaseUrl: string;
  mqttBroker: string;
  mqttPort: number;
  agentVersion: string;
  githubRepo: string;
  githubReleaseUrl: string;
}
```

**Step 2: Update methods that use config**

Update `generateInstallerScript()`, `buildInstallerUrl()`, `buildInstallerCommand()`, `activateDevice()`, `selfRegisterDevice()`, `generateTenantInstallerScript()` to call `await this.getProvisioningConfig()` instead of using `this.API_BASE_URL` etc. directly.

Key methods to update:
- `generateInstallerScript()` (line 201): `const config = await this.getProvisioningConfig();`
- `renderInstallerScript()` (line 376): Pass `githubRepo` and `githubReleaseUrl` from config
- `buildInstallerUrl()` (line 344): Make async, use `config.apiBaseUrl`
- `buildInstallerCommand()` (line 351): Make async
- `buildProvisioningResponse()` (line 358): Make async
- `activateDevice()` (line 240): Use `config.mqttBroker` and `config.mqttPort` for response
- `selfRegisterDevice()` (line 733): Same
- `createProvisionedDevice()` (line 105): Call async `buildProvisioningResponse`
- `createTenantKey()` (line 628): Call async `buildTenantInstallerUrl/Command`

**Step 3: Add SHA256 checksum verification to installer script template**

In `renderInstallerScript()` (line 376), update the download section to include checksum verification:

Replace the simple `curl` download with:

```bash
# Download binary + checksum
TARBALL="${BINARY_NAME}.tar.gz"
CHECKSUM_FILE="${TARBALL}.sha256"
DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/download/$LATEST_TAG/$TARBALL"
CHECKSUM_URL="https://github.com/$GITHUB_REPO/releases/download/$LATEST_TAG/$CHECKSUM_FILE"

log "Download URL: $DOWNLOAD_URL"

curl -fsSL -o "/tmp/${TARBALL}" "$DOWNLOAD_URL"
curl -fsSL -o "/tmp/${CHECKSUM_FILE}" "$CHECKSUM_URL"

# Verify checksum
log "Verifying SHA256 checksum..."
cd /tmp
if sha256sum -c "$CHECKSUM_FILE"; then
    log "Checksum verified ✅"
else
    log "ERROR: Checksum verification failed! Binary may be corrupted."
    rm -f "/tmp/${TARBALL}" "/tmp/${CHECKSUM_FILE}"
    exit 1
fi

# Extract and install
mkdir -p "$INSTALL_DIR"
tar -xzf "/tmp/${TARBALL}" -C "$INSTALL_DIR/"
mv "$INSTALL_DIR/edge-agent" "$INSTALL_DIR/edge-agent" 2>/dev/null || true
chmod +x "$INSTALL_DIR/edge-agent"
rm -f "/tmp/${TARBALL}" "/tmp/${CHECKSUM_FILE}"
```

Also update binary naming in both `renderInstallerScript()` and `renderTenantInstallerScript()` to match the CI/CD output format:
- Old: `edge-agent-x86_64-unknown-linux-gnu` (raw binary)
- New: `suderra-agent-x86_64-linux.tar.gz` (tarball with checksum)

**Step 4: Commit**

```bash
git add apps/sensor-service/src/edge-device/provisioning.service.ts
git commit -m "feat: read provisioning config from admin API with env var fallback, add SHA256 checksum verification"
```

---

## Task 4: Admin Panel - Provisioning Settings UI

**Context:** Admin panel uses React + TypeScript. Settings pages are in `web/modules/admin-panel/src/pages/`. The admin API is accessed via `adminApi.ts` service.

**Files:**
- Create: `web/modules/admin-panel/src/pages/ProvisioningSettingsPage.tsx`
- Modify: `web/modules/admin-panel/src/components/AdminSidebar.tsx` (add nav link)
- Modify: `web/shell/src/App.tsx` (add route)
- Modify: `web/modules/admin-panel/src/services/adminApi.ts` (add API methods)

**Step 1: Add API methods to adminApi.ts**

```typescript
// Provisioning Settings
getProvisioningConfig: async () => {
  const response = await api.get('/system-management/provisioning-config');
  return response.data;
},

updateProvisioningConfig: async (config: Record<string, string>) => {
  const response = await api.put('/system-management/provisioning-config', config);
  return response.data;
},
```

**Step 2: Create ProvisioningSettingsPage**

Standard form page with fields:
- Provisioning API URL (text input)
- MQTT Broker Host (text input)
- MQTT Broker Port (number input)
- GitHub Release URL (text input)
- GitHub Repo (text input, e.g., "Okan-wqm/sens")
- Agent Default Version (text input, "latest" or "v1.4.0")

Load current values on mount, save on submit. Show success/error toast.

Follow the pattern of existing settings pages (e.g., `DatabaseManagementPage.tsx` or `TenantDetailPage.tsx`).

**Step 3: Add sidebar link**

File: `web/modules/admin-panel/src/components/AdminSidebar.tsx`

Add a "Provisioning" or "Edge Agent" link under the Settings section.

**Step 4: Add route**

File: `web/shell/src/App.tsx`

Add route: `/admin/provisioning-settings` → `ProvisioningSettingsPage`

**Step 5: Commit**

```bash
git add web/modules/admin-panel/src/pages/ProvisioningSettingsPage.tsx
git add web/modules/admin-panel/src/components/AdminSidebar.tsx
git add web/modules/admin-panel/src/services/adminApi.ts
git add web/shell/src/App.tsx
git commit -m "feat: add provisioning settings page to admin panel"
```

---

## Task 5: Seed Default Provisioning Config Values

**Context:** When the system starts fresh, provisioning config should have sensible defaults in the DB so the admin panel shows populated fields.

**Files:**
- Create: `database/migrations/core/V007__seed_provisioning_config.sql`

**Step 1: Create migration**

```sql
-- V007: Seed default provisioning configuration values
-- These can be updated via Admin Panel > Provisioning Settings

INSERT INTO public.global_configs (id, key, value, category, description, value_type, is_active, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'provisioning.api_url', 'http://localhost:3000', 'provisioning', 'Base URL for the provisioning API that edge devices connect to', 'string', true, NOW(), NOW()),
  (gen_random_uuid(), 'provisioning.mqtt_broker_host', 'localhost', 'provisioning', 'MQTT broker hostname for edge device connections', 'string', true, NOW(), NOW()),
  (gen_random_uuid(), 'provisioning.mqtt_broker_port', '1883', 'provisioning', 'MQTT broker port', 'string', true, NOW(), NOW()),
  (gen_random_uuid(), 'provisioning.github_release_url', 'https://github.com/Okan-wqm/sens/releases', 'provisioning', 'GitHub Releases URL for edge agent binary downloads', 'string', true, NOW(), NOW()),
  (gen_random_uuid(), 'provisioning.agent_default_version', 'latest', 'provisioning', 'Default edge agent version to install (latest or pinned version tag)', 'string', true, NOW(), NOW()),
  (gen_random_uuid(), 'provisioning.github_repo', 'Okan-wqm/sens', 'provisioning', 'GitHub repository for edge agent releases', 'string', true, NOW(), NOW())
ON CONFLICT (key) DO NOTHING;
```

**Step 2: Verify migration file naming matches existing pattern**

Check `database/migrations/core/` for naming convention (V001, V002, etc.).

**Step 3: Commit**

```bash
git add database/migrations/core/V007__seed_provisioning_config.sql
git commit -m "feat: seed default provisioning config values"
```

---

## Task 6: Verify End-to-End Flow

**Step 1: Start services locally**

```bash
docker-compose up -d postgres redis
npm run start:dev -- admin-api-service
npm run start:dev -- sensor-service
```

**Step 2: Verify admin API provisioning config endpoint**

```bash
curl http://localhost:3010/system-management/provisioning-config
```
Expected: JSON with default provisioning values

**Step 3: Create a provisioned device via GraphQL**

```graphql
mutation {
  createProvisionedDevice(input: {
    deviceName: "Test IPC"
    deviceModel: INDUSTRIAL_PC
  }) {
    deviceId
    deviceCode
    installerUrl
    installerCommand
    tokenExpiresAt
    status
  }
}
```

Expected: `installerCommand` returns a real `curl -sSL ... | sudo sh` command

**Step 4: Verify installer script endpoint**

```bash
curl http://localhost:4003/install/{DEVICE_CODE}
```
Expected: Shell script with embedded device config, GitHub download URL, SHA256 checksum verification

**Step 5: Verify admin panel UI**

Open `http://localhost:8080/admin/provisioning-settings` and verify:
- Form loads with current config values
- Can update and save
- New device installer commands use updated values

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: edge device zero-touch provisioning with DB-backed config and CI/CD"
```

---

## Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | CI/CD workflow for Rust cross-compile | None (independent) |
| 2 | Admin API provisioning settings | None (independent) |
| 3 | ProvisioningService reads from admin API | Task 2 |
| 4 | Admin panel provisioning settings UI | Task 2 |
| 5 | Seed default config values | Task 2 |
| 6 | End-to-end verification | All tasks |

Tasks 1, 2 can run in parallel. Tasks 3, 4, 5 depend on Task 2. Task 6 verifies everything.
