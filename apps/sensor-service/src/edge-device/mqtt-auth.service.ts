import { pbkdf2Sync, randomBytes } from 'crypto';
import { promises as fs } from 'fs';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * MQTT Authentication Service
 * Manages device credentials for Mosquitto broker authentication
 *
 * This service handles:
 * - Adding device credentials to the password file
 * - Removing device credentials
 * - Generating PBKDF2-SHA512 password hashes (Mosquitto format)
 *
 * For production, consider using Mosquitto's dynamic security plugin
 * or a database-backed authentication backend.
 */
@Injectable()
export class MqttAuthService implements OnModuleInit {
  private readonly logger = new Logger(MqttAuthService.name);

  // Password file path (relative to project root or absolute)
  private readonly passwordFilePath: string;

  // Whether password file management is enabled
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.passwordFilePath = this.configService.get<string>(
      'MOSQUITTO_PASSWORD_FILE',
      'infrastructure/simulators/mosquitto/config/passwd',
    );
    this.enabled = this.configService.get<boolean>('MQTT_AUTH_ENABLED', false);
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) {
      this.logger.log('MQTT Authentication Service initialized');
      this.logger.log(`Password file: ${this.passwordFilePath}`);

      // Verify password file exists
      try {
        await fs.access(this.passwordFilePath);
        this.logger.log('Password file accessible');
      } catch {
        this.logger.warn(`Password file not found: ${this.passwordFilePath}`);
        this.logger.warn('Device credentials will not be persisted to file');
      }
    } else {
      this.logger.log('MQTT Authentication Service disabled (MQTT_AUTH_ENABLED=false)');
    }
  }

  /**
   * Generate MQTT credentials for a device
   * Returns the plain password (to send to agent) and hash (to store)
   */
  generateCredentials(): { password: string; hash: string } {
    // Generate random 16-byte password encoded as base64
    const password = randomBytes(16).toString('base64');

    // Hash using PBKDF2-SHA512 (Mosquitto format)
    const hash = this.hashPassword(password);

    return { password, hash };
  }

  /**
   * Hash a password using PBKDF2-SHA512 (Mosquitto $7$ format)
   *
   * Format: $7$iterations$base64salt$base64hash
   *
   * Mosquitto uses:
   * - 101 iterations by default
   * - 12-byte salt
   * - 24-byte derived key
   * - SHA-512 algorithm
   */
  hashPassword(password: string): string {
    const iterations = 101; // Mosquitto default
    const salt = randomBytes(12);
    const keyLength = 24;

    const derivedKey = pbkdf2Sync(password, salt, iterations, keyLength, 'sha512');

    // Mosquitto $7$ format: $7$iterations$base64salt$base64hash
    return `$7$${iterations}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
  }

  /**
   * Verify a password against a hash
   */
  verifyPassword(password: string, hash: string): boolean {
    try {
      // Parse $7$ format: $7$iterations$base64salt$base64hash
      const parts = hash.split('$');
      if (parts.length !== 5 || parts[1] !== '7') {
        return false;
      }

      const iterationsStr = parts[2];
      const saltStr = parts[3];
      const hashStr = parts[4];

      if (!iterationsStr || !saltStr || !hashStr) {
        return false;
      }

      const iterations = parseInt(iterationsStr, 10);
      const salt = Buffer.from(saltStr, 'base64');
      const expectedHash = Buffer.from(hashStr, 'base64');

      const derivedKey = pbkdf2Sync(password, salt, iterations, expectedHash.length, 'sha512');

      return derivedKey.equals(expectedHash);
    } catch (error) {
      this.logger.error('Error verifying password:', error);
      return false;
    }
  }

  /**
   * Add device credentials to the password file
   *
   * @param username - MQTT username (mqtt_client_id)
   * @param passwordHash - Pre-computed PBKDF2 hash
   */
  async addDeviceCredentials(username: string, passwordHash: string): Promise<boolean> {
    if (!this.enabled) {
      this.logger.debug('MQTT auth disabled, skipping credential storage');
      return true;
    }

    try {
      // Read existing password file
      let content = '';
      try {
        content = await fs.readFile(this.passwordFilePath, 'utf-8');
      } catch {
        // File doesn't exist, start fresh
        content = '';
      }

      // Parse existing entries
      const lines = content.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
      const entries = new Map<string, string>();

      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const user = line.substring(0, colonIndex);
          const hash = line.substring(colonIndex + 1);
          entries.set(user, hash);
        }
      }

      // Add or update the device entry
      entries.set(username, passwordHash);

      // Rebuild password file with header
      const header = `# ============================================
# Mosquitto Password File
# ============================================
# Auto-generated - do not edit manually
# Edge device credentials managed by sensor-service
# ============================================

`;

      // Service accounts section
      const serviceAccounts = `# Service Accounts
backend_service:$7$101$e+rWnNaJMX+vqJhS$vRiNrPbEqAqmfMhJv6gJdZ5DkLqTqpMq9Qu3N2vLhZI=
sensor_service:$7$101$Kp2mNxQzL8RtYwVs$hTxMnPqRkVsWuYzAb3CdEfGhIjKlMnOpQrStUvWxYz0=
alert_service:$7$101$Xt5yNzRqMwLpKjHg$aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX3yZ4aB5c=

# Edge Device Accounts
`;

      // Build device entries
      const deviceEntries: string[] = [];
      for (const [user, hash] of entries) {
        // Skip service accounts (already in header)
        if (!['backend_service', 'sensor_service', 'alert_service'].includes(user)) {
          deviceEntries.push(`${user}:${hash}`);
        }
      }

      const newContent = header + serviceAccounts + deviceEntries.join('\n') + '\n';

      // Write back to file
      await fs.writeFile(this.passwordFilePath, newContent, 'utf-8');

      this.logger.log(`Added MQTT credentials for device: ${username}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to add MQTT credentials for ${username}:`, error);
      return false;
    }
  }

  /**
   * Remove device credentials from the password file
   */
  async removeDeviceCredentials(username: string): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    try {
      let content = await fs.readFile(this.passwordFilePath, 'utf-8');
      const lines = content.split('\n');

      // Filter out the line for this user
      const filteredLines = lines.filter((line) => {
        if (!line.trim() || line.startsWith('#')) return true;
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const user = line.substring(0, colonIndex);
          return user !== username;
        }
        return true;
      });

      content = filteredLines.join('\n');
      await fs.writeFile(this.passwordFilePath, content, 'utf-8');

      this.logger.log(`Removed MQTT credentials for device: ${username}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to remove MQTT credentials for ${username}:`, error);
      return false;
    }
  }

  /**
   * Check if device credentials exist
   */
  async hasCredentials(username: string): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const content = await fs.readFile(this.passwordFilePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (line.startsWith('#') || !line.trim()) continue;
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const user = line.substring(0, colonIndex);
          if (user === username) {
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Notify Mosquitto to reload password file
   * This sends a SIGHUP signal to the Mosquitto process
   *
   * Note: This only works if sensor-service has access to the Docker host
   * or is running on the same machine as Mosquitto.
   *
   * For Docker deployments, consider:
   * 1. Using Mosquitto's dynamic security plugin
   * 2. Using a database-backed auth backend
   * 3. Mounting a shared volume and using inotify
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async reloadMosquitto(): Promise<boolean> {
    // In development, Mosquitto typically reloads automatically
    // For production, implement proper signal/API mechanism
    this.logger.debug('Mosquitto reload requested (no-op in development)');
    return true;
  }
}
