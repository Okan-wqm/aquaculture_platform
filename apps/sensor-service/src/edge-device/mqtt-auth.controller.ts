import { timingSafeEqual } from 'crypto';

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
 * - Network isolation is the boundary: only the aqua-internal network reaches
 *   sensor-service:3000, and nginx refuses /mqtt/* from outside.
 * - X-Mosquitto-Auth, when a caller sends it, must equal MQTT_AUTH_SECRET
 *   (constant-time). The broker itself cannot send it — see validateMosquittoSecret.
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

    // mosquitto-go-auth (pinned 3.0.0, also the latest release) sets only
    // Content-Type and User-Agent on its HTTP calls: backends/http.go parses no
    // header option, so `auth_opt_http_headers` in mosquitto-production.conf is
    // silently ignored and the broker never sends X-Mosquitto-Auth. The secret
    // therefore authenticates nobody today; the endpoints rest on network
    // isolation. Tracked as SENSOR-MEDIUM-174 (a transport the broker can carry).
    if (this.mqttAuthSecret) {
      this.logger.log('MQTT_AUTH_SECRET is configured — a sent X-Mosquitto-Auth header must match it');
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
   * Validate X-Mosquitto-Auth against MQTT_AUTH_SECRET.
   *
   * A header that is sent must match, compared in constant time on
   * equal-length buffers (a length mismatch is a denial, decided before any
   * byte comparison). An ABSENT header is admitted: mosquitto-go-auth cannot
   * send one (see the constructor), so requiring it would refuse every
   * CONNECT and ACL check in production. SENSOR-MEDIUM-174 tracks moving the
   * secret onto a transport the broker supports, after which absence denies.
   */
  private validateMosquittoSecret(headers: Record<string, string | undefined>): void {
    if (!this.mqttAuthSecret) return;

    const headerValue = headers['x-mosquitto-auth'];
    if (headerValue === undefined) return;

    const sent = Buffer.from(headerValue, 'utf8');
    const expected = Buffer.from(this.mqttAuthSecret, 'utf8');
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
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
    @Headers() headers: Record<string, string | undefined>,
    @Body() body: { username: string; password: string; clientid?: string },
  ): Promise<string> {
    this.validateMosquittoSecret(headers);

    const { username, password, clientid } = body;

    if (!username || !password) {
      this.logger.debug('MQTT auth rejected: missing credentials');
      throw new MqttAuthDeniedException();
    }

    const isValid = await this.mqttAuthService.verifyDeviceCredentials(
      username,
      password,
      clientid,
    );

    if (!isValid) {
      // The reason and a username fingerprint are logged by the service.
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
    @Headers() headers: Record<string, string | undefined>,
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
    @Headers() headers: Record<string, string | undefined>,
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
