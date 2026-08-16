import { readFileSync, existsSync } from 'fs';

import { Logger } from '@nestjs/common';

const logger = new Logger('SecretsProvider');

/**
 * Read a secret from file or env var, with file taking priority.
 *
 * Convention: if VAR_NAME has a corresponding VAR_NAME_FILE env var
 * pointing to a readable file, the file content is used instead.
 *
 * Docker Secrets mounts files under /run/secrets/ (memory-backed tmpfs,
 * never written to disk). This helper lets every service transparently
 * consume secrets from either source.
 *
 * @example
 *   // JWT_SECRET_FILE=/run/secrets/jwt_secret  -> reads file content
 *   // JWT_SECRET=some-value                    -> fallback to env var
 *   const secret = readSecret('JWT_SECRET');
 */
export function readSecret(envVarName: string): string | undefined {
  const fileEnvVar = `${envVarName}_FILE`;
  const filePath = process.env[fileEnvVar];

  if (filePath) {
    if (existsSync(filePath)) {
      try {
        const value = readFileSync(filePath, 'utf8').trim();
        if (value.length > 0) {
          logger.log(`Secret "${envVarName}" loaded from file (${fileEnvVar})`);
          return value;
        }
        logger.warn(`Secret file for "${envVarName}" exists but is empty, falling back to env var`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to read secret file for "${envVarName}" at ${filePath}: ${errorMessage}`,
        );
      }
    } else {
      logger.warn(
        `${fileEnvVar}=${filePath} is set but file does not exist, falling back to env var`,
      );
    }
  }

  return process.env[envVarName];
}

/**
 * Resolve multiple secrets at once and inject them into process.env so that
 * NestJS ConfigService / process.env readers pick them up automatically.
 *
 * Call this once at the top of main.ts (before NestFactory.create) to ensure
 * all secret values are available throughout the application lifecycle.
 *
 * @param envVarNames - List of env var names to resolve via readSecret()
 */
export function bootstrapSecrets(envVarNames: string[]): void {
  for (const name of envVarNames) {
    const value = readSecret(name);
    if (value !== undefined && value !== process.env[name]) {
      process.env[name] = value;
    }
  }
}
