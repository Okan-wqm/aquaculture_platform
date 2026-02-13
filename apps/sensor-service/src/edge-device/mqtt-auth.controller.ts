import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpException,
  HttpStatus,
  Headers,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SimpleRateLimitGuard, RateLimit } from '../guards/rate-limit.guard';
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
 * - Rate limited to prevent brute-force attacks
 * - Optional shared secret (MQTT_AUTH_SECRET) to ensure only Mosquitto calls these endpoints
 *
 * Response convention: HTTP 200 = allowed, HTTP 403 = denied
 */
@Controller('mqtt')
@UseGuards(SimpleRateLimitGuard)
export class MqttAuthController {
  private readonly logger = new Logger(MqttAuthController.name);
  private readonly mqttAuthSecret: string | undefined;

  constructor(
    private readonly mqttAuthService: MqttAuthService,
    private readonly configService: ConfigService,
  ) {
    this.mqttAuthSecret = this.configService.get<string>('MQTT_AUTH_SECRET');
  }

  /**
   * Validate the shared secret from Mosquitto.
   * If MQTT_AUTH_SECRET is configured, the X-Mosquitto-Auth header must match.
   * If not configured, skip validation (backward compatible).
   */
  private validateMosquittoSecret(headers: Record<string, string>): void {
    if (this.mqttAuthSecret && headers['x-mosquitto-auth'] !== this.mqttAuthSecret) {
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
  @RateLimit({ limit: 30, windowMs: 60000 })
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
   * acc values: 1=subscribe, 2=publish, 3=subscribe+publish, 4=deny
   * Returns: 200 if allowed, 403 if denied
   */
  @Post('acl')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 60, windowMs: 60000 })
  async checkAcl(
    @Headers() headers: Record<string, string>,
    @Body() body: { username: string; topic: string; clientid?: string; acc: number },
  ): Promise<string> {
    this.validateMosquittoSecret(headers);

    const { username, topic, acc } = body;

    const isAllowed = await this.mqttAuthService.checkTopicAccess(username, topic, acc);

    if (!isAllowed) {
      this.logger.debug(`MQTT ACL denied: user=${username} topic=${topic} acc=${acc}`);
      throw new MqttAuthDeniedException();
    }

    return 'ok';
  }
}
