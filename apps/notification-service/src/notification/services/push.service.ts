import { createRequire } from 'node:module';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Minimal structural surface of the optional `firebase-admin` peer dependency.
 *
 * WHY: firebase-admin is an OPTIONAL runtime dependency — it is not in
 * package.json and is absent unless an operator installs it for the
 * `firebase` push provider. We therefore cannot `import` it statically
 * (TS would fail to resolve the module and, under `module: commonjs`,
 * down-level the call to an eager `require` that throws at load time even
 * when the active provider is `mock`). Declaring only the members we call
 * lets us load it lazily through `createRequire` with full type safety and
 * no `any`, while a missing package surfaces as a catchable `MODULE_NOT_FOUND`.
 */
interface FirebaseApp {
  readonly name: string;
}

interface FirebaseMessage {
  token: string;
  notification: { title: string; body: string };
  data?: Record<string, string>;
  android: { notification: { sound: string } };
  webpush: { notification: { badge?: string } };
}

interface FirebaseMessaging {
  send(message: FirebaseMessage): Promise<string>;
}

interface FirebaseCredential {
  readonly projectId?: string;
}

interface FirebaseAdminModule {
  credential: { cert(serviceAccount: unknown): FirebaseCredential };
  initializeApp(options: { credential: FirebaseCredential }): FirebaseApp;
  messaging(app: FirebaseApp): FirebaseMessaging;
}

/**
 * Structural guard validating that a lazily-resolved module exposes the
 * firebase-admin members we depend on, so the rest of the code can rely on
 * the typed surface without any unchecked casts.
 */
function isFirebaseAdminModule(value: unknown): value is FirebaseAdminModule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const credential = candidate.credential;
  return (
    typeof candidate.initializeApp === 'function' &&
    typeof candidate.messaging === 'function' &&
    typeof credential === 'object' &&
    credential !== null &&
    typeof (credential as Record<string, unknown>).cert === 'function'
  );
}

/**
 * Mask device token for logging (shows first 8 and last 4 chars)
 */
function maskDeviceToken(token: string): string {
  if (token.length <= 12) {
    return '***';
  }
  return token.substring(0, 8) + '...' + token.slice(-4);
}

/**
 * Push notification data
 */
export interface PushNotificationData {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  badge?: number;
  sound?: string;
}

/**
 * Push Service
 * Handles push notifications to mobile devices and web browsers
 * Currently implements a mock provider - can be extended for Firebase, OneSignal, etc.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly isEnabled: boolean;
  private readonly provider: string;
  private readonly isProduction: boolean;
  private providerHealthy = true;

  private firebaseApp: FirebaseApp | null = null;

  // Supported providers that have actual implementations
  private static readonly IMPLEMENTED_PROVIDERS = ['mock', 'firebase'];
  private static readonly PLANNED_PROVIDERS = ['onesignal', 'apns'];

  constructor(private readonly configService: ConfigService) {
    this.isEnabled = this.configService.get('PUSH_ENABLED', 'false') === 'true';
    this.provider = this.configService.get('PUSH_PROVIDER', 'mock');
    this.isProduction = this.configService.get('NODE_ENV') === 'production';

    // SECURITY: Validate configuration at startup
    this.validateConfiguration();

    if (this.isEnabled) {
      this.logger.log(`Push service initialized with provider: ${this.provider}`);
    } else {
      this.logger.warn('Push service is disabled');
    }
  }

  /**
   * Validate push notification configuration at startup
   * Warns if non-implemented provider is configured
   */
  private validateConfiguration(): void {
    if (!this.isEnabled) {
      return;
    }

    const isImplemented = PushService.IMPLEMENTED_PROVIDERS.includes(this.provider);
    const isPlanned = PushService.PLANNED_PROVIDERS.includes(this.provider);

    if (!isImplemented && !isPlanned) {
      this.logger.error(
        `Unknown push provider configured: ${this.provider}. ` +
        `Valid options: ${[...PushService.IMPLEMENTED_PROVIDERS, ...PushService.PLANNED_PROVIDERS].join(', ')}`,
      );
      this.providerHealthy = false;
    }

    if (isPlanned && !isImplemented) {
      const message = `Push provider '${this.provider}' is configured but not yet implemented. ` +
        `Falling back to mock provider. Set PUSH_PROVIDER=mock to silence this warning.`;

      if (this.isProduction) {
        // CRITICAL: In production, log error and mark unhealthy
        this.logger.error(`PRODUCTION WARNING: ${message}`);
        this.providerHealthy = false;
      } else {
        this.logger.warn(message);
      }
    }

    // Validate Firebase-specific configuration
    if (this.provider === 'firebase') {
      const serviceAccount = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT');
      if (!serviceAccount) {
        this.logger.error(
          `Firebase push provider is missing FIREBASE_SERVICE_ACCOUNT env var. ` +
          `Push notifications will fail until this is configured.`,
        );
        this.providerHealthy = false;
      } else {
        // Validate that it's valid JSON
        try {
          JSON.parse(serviceAccount);
        } catch {
          this.logger.error(
            `FIREBASE_SERVICE_ACCOUNT env var contains invalid JSON. ` +
            `Push notifications will fail.`,
          );
          this.providerHealthy = false;
        }
      }
    }
  }

  /**
   * Check if push provider is healthy
   */
  isHealthy(): boolean {
    return this.providerHealthy;
  }

  /**
   * Get provider status for health checks
   */
  getProviderStatus(): { provider: string; enabled: boolean; healthy: boolean; implemented: boolean } {
    return {
      provider: this.provider,
      enabled: this.isEnabled,
      healthy: this.providerHealthy,
      implemented: PushService.IMPLEMENTED_PROVIDERS.includes(this.provider),
    };
  }

  /**
   * Send a push notification
   */
  async sendPushNotification(
    deviceToken: string,
    notification: PushNotificationData,
  ): Promise<string> {
    if (!this.isEnabled) {
      this.logger.warn(`Push not sent (disabled): to ${maskDeviceToken(deviceToken)}`);
      return `mock-push-${Date.now()}`;
    }

    try {
      let messageId: string;

      switch (this.provider) {
        case 'firebase':
          messageId = await this.sendViaFirebase(deviceToken, notification);
          break;
        case 'onesignal':
          messageId = await this.sendViaOneSignal(deviceToken, notification);
          break;
        case 'apns':
          messageId = await this.sendViaApns(deviceToken, notification);
          break;
        case 'mock':
        default:
          messageId = await this.sendViaMock(deviceToken, notification);
          break;
      }

      this.logger.log(`Push notification sent: ${messageId}`);
      return messageId;
    } catch (error) {
      this.logger.error(
        `Failed to send push notification: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Send alert push notification
   */
  async sendAlertPush(
    deviceToken: string,
    alertData: {
      ruleName: string;
      severity: string;
      message: string;
      alertId?: string;
    },
  ): Promise<string> {
    const notification: PushNotificationData = {
      title: `[${alertData.severity.toUpperCase()}] Alert`,
      body: alertData.message,
      data: {
        type: 'alert',
        alertId: alertData.alertId,
        ruleName: alertData.ruleName,
        severity: alertData.severity,
      },
      sound: alertData.severity === 'critical' ? 'critical.wav' : 'default',
    };

    return await this.sendPushNotification(deviceToken, notification);
  }

  /**
   * Send task push notification
   */
  async sendTaskPush(
    deviceToken: string,
    taskData: { title: string; taskId: string; type: string },
  ): Promise<string> {
    const notification: PushNotificationData = {
      title: 'G\u00F6rev Bildirimi',
      body: taskData.title,
      data: { type: taskData.type, taskId: taskData.taskId },
      sound: 'default',
    };
    return await this.sendPushNotification(deviceToken, notification);
  }

  /**
   * Mock push provider (for development/testing)
   */
  private async sendViaMock(
    deviceToken: string,
    notification: PushNotificationData,
  ): Promise<string> {
    this.logger.debug(
      `[MOCK PUSH] To: ${maskDeviceToken(deviceToken)}, Title: ${notification.title}`,
    );
    return `mock-push-${Date.now()}`;
  }

  /**
   * Resolve the optional firebase-admin SDK at runtime.
   *
   * WHY createRequire (not import/require directly): firebase-admin is an
   * optional peer dependency that may be absent. A lazy resolve isolates the
   * module lookup to the moment the firebase provider is actually used, and a
   * missing package raises a catchable MODULE_NOT_FOUND we translate into an
   * actionable error. The module's runtime shape is validated structurally
   * against FirebaseAdminModule rather than trusted blindly.
   */
  private getFirebaseAdmin(): FirebaseAdminModule {
    const requireFn = createRequire(__filename);
    let mod: unknown;
    try {
      mod = requireFn('firebase-admin');
    } catch {
      throw new Error(
        'firebase-admin package is not installed. Run: npm install firebase-admin',
      );
    }
    if (!isFirebaseAdminModule(mod)) {
      throw new Error(
        'firebase-admin module does not expose the expected API surface',
      );
    }
    return mod;
  }

  private getFirebaseApp(): FirebaseApp {
    if (this.firebaseApp) return this.firebaseApp;
    const serviceAccountJson = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT');
    if (!serviceAccountJson) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
    }
    const admin = this.getFirebaseAdmin();
    const serviceAccount: unknown = JSON.parse(serviceAccountJson);
    this.firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    return this.firebaseApp;
  }

  /**
   * Firebase Cloud Messaging provider
   */
  private async sendViaFirebase(
    deviceToken: string,
    notification: PushNotificationData,
  ): Promise<string> {
    const app = this.getFirebaseApp();
    const admin = this.getFirebaseAdmin();
    const message: FirebaseMessage = {
      token: deviceToken,
      notification: { title: notification.title, body: notification.body },
      data: notification.data
        ? Object.fromEntries(
            Object.entries(notification.data).map(([k, v]) => [k, String(v)]),
          )
        : undefined,
      android: { notification: { sound: notification.sound || 'default' } },
      webpush: { notification: { badge: notification.badge?.toString() } },
    };
    const result = await admin.messaging(app).send(message);
    return result;
  }

  /**
   * OneSignal provider (placeholder)
   */
  private async sendViaOneSignal(
    _deviceToken: string,
    _notification: PushNotificationData,
  ): Promise<string> {
    // TODO: Implement OneSignal integration

    throw new Error(
      'OneSignal push provider is not yet implemented. Set PUSH_PROVIDER=mock or implement OneSignal integration.',
    );
  }

  /**
   * Apple Push Notification Service provider (placeholder)
   */
  private async sendViaApns(
    _deviceToken: string,
    _notification: PushNotificationData,
  ): Promise<string> {
    // TODO: Implement APNS integration

    throw new Error(
      'APNS push provider is not yet implemented. Set PUSH_PROVIDER=mock or implement APNS integration.',
    );
  }
}
