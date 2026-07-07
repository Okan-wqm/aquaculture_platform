/**
 * SENSOR-MEDIUM-002 — provisioning tokens travel in a header, never the URL.
 *
 * A secret placed in a URL query/path leaks into nginx / proxy access logs,
 * shell history and Referer headers. The installer builders must therefore emit
 * a bare endpoint URL and carry the token in a request header.
 */
import { InstallerScriptService } from '../installer-script.service';

describe('Installer commands carry the token in a header (SENSOR-MEDIUM-002)', () => {
  let service: InstallerScriptService;

  const configService = {
    get: <T>(key: string, fallback?: T): T => {
      const env: Record<string, unknown> = {
        PROVISIONING_API_BASE_URL: 'https://edge.example.com',
      };
      return (env[key] as T) ?? (fallback as T);
    },
  };

  beforeEach(() => {
    // Force the env-var fallback path in getProvisioningConfig.
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as never;
    service = new InstallerScriptService(configService as never);
  });

  it('device installer URL has no token; the command sends X-Provisioning-Token', async () => {
    const token = 'a1b2c3d4'.repeat(8); // 64-hex

    const url = await service.buildInstallerUrl('EDGE-AABB1122');
    expect(url).toBe('https://edge.example.com/install/EDGE-AABB1122');
    expect(url).not.toContain('?token=');
    expect(url).not.toContain(token);

    const command = await service.buildInstallerCommand('EDGE-AABB1122', token);
    expect(command).toBe(
      `curl -sSL -H "X-Provisioning-Token: ${token}" "https://edge.example.com/install/EDGE-AABB1122" | sudo bash`,
    );
    expect(command).not.toContain('?token=');
  });

  it('tenant installer URL has no token in the path; command sends the tenant header', async () => {
    const token = 'f00dbabe'.repeat(8); // 64-hex

    const url = await service.buildTenantInstallerUrl();
    expect(url).toBe('https://edge.example.com/install/tenant');
    expect(url).not.toContain(token);

    const command = await service.buildTenantInstallerCommand(token);
    expect(command).toBe(
      `curl -sSL -H "X-Tenant-Provisioning-Token: ${token}" https://edge.example.com/install/tenant | sudo bash`,
    );
    expect(command).not.toContain(`/install/t/${token}`);
  });

  it('suderra-os manifest URL carries no token', async () => {
    const url = await service.buildSuderraOsInstallerUrl('EDGE-AABB1122');
    expect(url).toBe('https://edge.example.com/install/EDGE-AABB1122/suderra-os');
    expect(url).not.toContain('?token=');
  });
});
