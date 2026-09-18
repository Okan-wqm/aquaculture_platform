import { ConfigService } from '@nestjs/config';

const DEVELOPMENT_FRONTEND_URL = 'http://localhost:8080';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/**
 * Canonical, fail-closed reader for the origin every e-mailed action link
 * (invitation acceptance, password reset) points at.
 *
 * DEPLOY-HIGH-016: the previous reader was an inline
 * `configService.get('FRONTEND_URL', 'http://localhost:8080')` inside the
 * controller that mints those links, and no deployment set FRONTEND_URL on
 * auth-service — the droplet compose provisioned it to admin-api-service,
 * which does not read it. Every invitation and password-reset e-mail
 * notification-service sent therefore carried a `http://localhost:8080` link,
 * and nothing failed: a default that is valid in development is silently
 * wrong in production.
 *
 * The default is kept for development and test, where it is correct, and is
 * refused everywhere it is not. Outside those environments the key is
 * REQUIRED and validated, so a deployment that forgets it fails to start
 * instead of mailing dead links to real users.
 *
 * Accepted: an absolute http(s) URL with no query, fragment or credentials;
 * a trailing slash is trimmed. In production and staging the scheme must be
 * https and the host must not be a loopback address.
 */
export function parseFrontendUrl(configService: ConfigService): string {
  const environment = configService.get<string>('NODE_ENV', 'development');
  const deployed = environment === 'production' || environment === 'staging';
  const raw = configService.get<unknown>('FRONTEND_URL');

  if (raw === undefined || raw === '') {
    if (deployed) {
      throw new Error(
        `FRONTEND_URL is required in ${environment}: it is the https origin of the web shell ` +
          'that every invitation and password-reset link points at.',
      );
    }
    return DEVELOPMENT_FRONTEND_URL;
  }
  if (typeof raw !== 'string') {
    throw new Error('FRONTEND_URL must be an absolute http(s) URL');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('FRONTEND_URL must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('FRONTEND_URL must be an absolute http(s) URL');
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error('FRONTEND_URL must not carry a query, fragment or credentials');
  }
  if (deployed) {
    if (url.protocol !== 'https:') {
      throw new Error(`FRONTEND_URL must use https in ${environment}`);
    }
    if (LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error(`FRONTEND_URL must not point at a loopback host in ${environment}`);
    }
  }

  return url.toString().replace(/\/+$/, '');
}
