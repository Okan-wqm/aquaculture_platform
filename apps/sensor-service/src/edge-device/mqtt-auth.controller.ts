import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpException,
  HttpStatus,
  Headers,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public, SkipTenantGuard } from '@aquaculture/backend-common/decorators';
import { MqttAuthService } from './mqtt-auth.service';

/**
 * Custom exception that returns 403 for Mosquitto auth denials.
 * Mosquitto expects 200=allowed, 403=denied.
 */
class MqttAuthDeniedException extends HttpException {
  constructor() {
    super('Denied', HttpStatus.FORBIDDEN);
  }
}

/**
 * MQTT Authentication Controller
 * HTTP auth backend for Mosquitto (mosquitto-go-auth plugin).
 *
 * Mosquitto sends HTTP requests to these endpoints for:
 * - User authentication (username/password verification)
 * - ACL authorization (topic-level access control)
 * - Superuser check (service accounts with full access)
 *
 * This replaces the file-based password_file approach, providing:
 * - DB-backed credential verification (participates in transactions)
 * - Proper cross-tenant ACL enforcement
 * - No file locking or atomic write complexity
 *
 * Security:
 * - Docker network isolation (only Mosquitto on internal network can reach these endpoints)
 * - Optional shared secret (MQTT_AUTH_SECRET) for additional validation when header is present
 *
 * Response convention: HTTP 200 = allowed, HTTP 403 = denied
 */
@Controller('mqtt')
@Public()
@SkipTenantGuard()
export class MqttAuthController {
  private readonly logger = new Logger(MqttAuthController.name);
  private readonly mqttAuthSecret: string | undefined;

  constructor(
    private readonly mqttAuthService: MqttAuthService,
    private readonly configService: ConfigService,
  ) {
    this.mqttAuthSecret = this.configService.get<string>('MQTT_AUTH_SECRET');

    // Note: mosquitto-go-auth does NOT support custom HTTP headers (auth_opt_http_headers
    // is not a real config option). The shared secret validation is only effective when
    // a reverse proxy or custom MQTT auth client injects the header. For the default
    // go-auth HTTP backend, security relies on Docker network isolation (only Mosquitto
    // can reach these endpoints on the internal network).
    if (this.mqttAuthSecret) {
      this.logger.log('MQTT_AUTH_SECRET is configured — header validation enabled for clients that send X-Mosquitto-Auth');
    } else {
      this.logger.warn('MQTT_AUTH_SECRET is not set — relying on Docker network isolation for MQTT auth endpoint security');
    }

    // LOW-003: Startup verification that MQTT auth endpoints are not publicly reachable.
    // If Docker network isolation is misconfigured (compose network not internal:true,
    // or nginx proxy misconfiguration), these endpoints accept unauthenticated auth
    // decisions from any caller.
    const nodeEnv = this.configService.get<string>('NODE_ENV');
    const isolationVerified =
      this.configService.get<string>('MQTT_NETWORK_ISOLATION_VERIFIED') === 'true';
    if (nodeEnv === 'production' && !this.mqttAuthSecret && !isolationVerified) {
      // SENSOR-MEDIUM-003: fail closed at bootstrap instead of only logging.
      // In production, either a shared secret must be set OR the operator must
      // explicitly attest network isolation (MQTT_NETWORK_ISOLATION_VERIFIED=true)
      // — otherwise these @Public MQTT auth endpoints could make unauthenticated
      // auth decisions for any caller that reaches them.
      throw new Error(
        'SECURITY: MQTT auth endpoints require MQTT_AUTH_SECRET (or an explicit ' +
        'MQTT_NETWORK_ISOLATION_VERIFIED=true attestation) in production. Refusing to start.',
      );
    }
  }

  /**
   * Validate the shared secret from Mosquitto (when available).
   *
   * mosquitto-go-auth does NOT support auth_opt_http_headers, so the header
   * is only present when a custom proxy or client sends it. When the header
   * is absent we allow the request through — security is provided by Docker
   * network isolation (only Mosquitto on the internal network can reach this
   * endpoint; Nginx does NOT proxy /mqtt/* to the outside).
   */
  private validateMosquittoSecret(headers: Record<string, string>): void {
    if (!this.mqttAuthSecret) return;

    const headerValue = headers['x-mosquitto-auth'];
    // If the header IS present, it must match (prevents misuse from other internal services)
    if (headerValue && headerValue !== this.mqttAuthSecret) {
      throw new MqttAuthDeniedException();
    }
  }

  /**
   * POST /mqtt/auth
   * Verify MQTT client credentials.
   * Called by Mosquitto on every CONNECT attempt.
   *
   * Body: { username: string, password: string, clientid?: string }
   * Returns: 200 if valid, 403 if invalid
   */
  @Post('auth')
  @HttpCode(HttpStatus.OK)
  async authenticate(
    @Headers() headers: Record<string, string>,
    @Body() body: { username: string; password: string; clientid?: string },
  ): Promise<string> {
    this.validateMosquittoSecret(headers);

    const { username, password } = body;

    if (!username || !password) {
      this.logger.debug('MQTT auth rejected: missing credentials');
      throw new MqttAuthDeniedException();
    }

    const isValid = await this.mqttAuthService.verifyDeviceCredentials(username, password);

    if (!isValid) {
      this.logger.debug(`MQTT auth rejected for user: ${username}`);
      throw new MqttAuthDeniedException();
    }

    return 'ok';
  }

  /**
   * POST /mqtt/superuser
   * Check if user is a superuser (service accounts).
   * Superusers bypass ACL checks entirely.
   *
   * Body: { username: string }
   * Returns: 200 if superuser, 403 if not
   */
  @Post('superuser')
  @HttpCode(HttpStatus.OK)
  async checkSuperuser(
    @Headers() headers: Record<string, string>,
    @Body() body: { username: string },
  ): Promise<string> {
    this.validateMosquittoSecret(headers);

    const isSuperuser = this.mqttAuthService.isSuperuser(body.username);

    if (!isSuperuser) {
      throw new MqttAuthDeniedException();
    }

    return 'ok';
  }

  /**
   * POST /mqtt/acl
   * Validate topic access for a device.
   * Called by Mosquitto on every PUBLISH/SUBSCRIBE attempt.
   *
   * Enforces tenant isolation: devices can only access topics under their own tenant.
   *
   * Body: { username: string, topic: string, clientid?: string, acc: number }
   * acc values: 1=read, 2=write/publish, 4=subscribe (MOSQ_ACL_SUBSCRIBE)
   * Returns: 200 if allowed, 403 if denied
   */
  @Post('acl')
  @HttpCode(HttpStatus.OK)
  async checkAcl(
    @Headers() headers: Record<string, string>,
    @Body() body: { username: string; topic: string; clientid?: string; acc: number },
  ): Promise<string> {
    this.validateMosquittoSecret(headers);

    const { username, topic, acc } = body;

    // mosquitto-go-auth sends form-urlencoded data — acc arrives as string
    const isAllowed = await this.mqttAuthService.checkTopicAccess(username, topic, Number(acc));

    if (!isAllowed) {
      this.logger.warn(`MQTT ACL denied: user=${username} topic=${topic} acc=${acc}`);
      throw new MqttAuthDeniedException();
    }

    return 'ok';
  }
}
