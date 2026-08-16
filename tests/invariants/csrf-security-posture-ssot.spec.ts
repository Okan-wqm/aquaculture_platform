import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CSRF_SECURITY_POSTURE } from '../../libs/shared-contracts/src/http/csrf-security-posture';

const ROOT = resolve(process.cwd());

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function webSources(directory: string): string[] {
  const absolute = join(ROOT, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) return webSources(relative);
    return /\.(?:html|ts|tsx)$/.test(entry.name) ? [source(relative)] : [];
  });
}

describe('browser credential and CSRF authority', () => {
  it('declares the bearer + SameSite refresh posture centrally', () => {
    expect(CSRF_SECURITY_POSTURE).toEqual({
      accessCredentialTransport: 'authorization-bearer',
      adminApiCredentialsMode: 'omit',
      doubleSubmitTokenEnabled: false,
      refresh: {
        cookieName: 'refresh_token',
        httpOnly: true,
        sameSite: 'lax',
        operationMethod: 'POST',
        credentialsMode: 'include',
      },
    });
  });

  it('has no orphan client half of a double-submit protocol', () => {
    const web = webSources('web').join('\n');
    expect(web).not.toMatch(/XSRF-TOKEN|X-CSRF-Token|x-csrf-token|csrf-token/);
  });

  it('binds the auth cookie and browser transports to the shared contract', () => {
    const cookie = source(
      'apps/auth-service/src/modules/authentication/utils/refresh-token-cookie.ts',
    );
    const sharedClient = source('web/shared-ui/src/utils/api-client.ts');
    const adminClient = source('web/modules/admin-panel/src/services/http-client.ts');

    expect(cookie).toMatch(/CSRF_SECURITY_POSTURE\.refresh\.cookieName/);
    expect(cookie).toMatch(/CSRF_SECURITY_POSTURE\.refresh\.httpOnly/);
    expect(cookie).toMatch(/CSRF_SECURITY_POSTURE\.refresh\.sameSite/);
    expect(sharedClient).toMatch(/CSRF_SECURITY_POSTURE\.refresh\.operationMethod/);
    expect(sharedClient).toMatch(/CSRF_SECURITY_POSTURE\.refresh\.credentialsMode/);
    expect(adminClient).toMatch(/CSRF_SECURITY_POSTURE\.adminApiCredentialsMode/);
  });

  it('does not mount a contradictory gateway double-submit middleware', () => {
    const gatewayModule = source('apps/gateway-api/src/app.module.ts');
    const gatewayMain = source('apps/gateway-api/src/main.ts');
    expect(gatewayModule).not.toMatch(/CsrfMiddleware/);
    expect(gatewayMain).not.toMatch(/X-CSRF-Token|x-csrf-token/);
  });

  it('does not expose the retired impersonation identity header through CORS', () => {
    expect(source('apps/admin-api-service/src/main.ts')).not.toMatch(/X-Impersonate-User/i);
  });
});
