import { Logger } from '@nestjs/common';
import { ValueTransformer } from 'typeorm';

import { getVaultInstance } from './credential.transformer';
import { hasSecretField, mapProtocolSecretFields } from './protocol-secret-fields';

const logger = new Logger('ProtocolConfigVault');

type ConfigValue = Record<string, unknown> | null | undefined;

/** Minimal cipher surface the protocol-config encryption needs. */
export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(value: string): string;
  isEncrypted(value: string): boolean;
}

/**
 * Encrypt the secret-named fields of a protocol config for at-rest storage.
 * A secret-free config is returned verbatim (safe even with no cipher wired);
 * a config with secrets and no cipher throws rather than persist plaintext.
 */
export function encryptProtocolConfig(
  value: ConfigValue,
  cipher: SecretCipher | null,
): ConfigValue {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (!cipher) {
    if (hasSecretField(value)) {
      logger.error('Vault not initialized — refusing to store plaintext protocol credentials');
      throw new Error('CredentialVault not initialized — cannot store protocol secrets at rest');
    }
    return value;
  }
  return mapProtocolSecretFields(value, (secret) =>
    cipher.isEncrypted(secret) ? secret : cipher.encrypt(secret),
  );
}

/**
 * Decrypt the secret-named fields of a stored protocol config back to plaintext
 * so adapters can connect. Without a cipher (startup / migration) the value is
 * returned raw.
 */
export function decryptProtocolConfig(
  value: ConfigValue,
  cipher: SecretCipher | null,
): ConfigValue {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (!cipher) {
    return value;
  }
  return mapProtocolSecretFields(value, (stored) => {
    try {
      return cipher.decrypt(stored);
    } catch {
      // Never log credential content — only an opaque marker.
      logger.error('Decryption failed for a stored protocol credential (value redacted)');
      return '[DECRYPTION_FAILED]';
    }
  });
}

/**
 * Field-level at-rest encryption for the `protocol_configuration` jsonb column
 * (SENSOR-MEDIUM-080).
 *
 * Protocol configs mix connection metadata (host, port, topic) with live device
 * credentials (Basic-auth passwords, bearer tokens, API keys, OAuth2 secrets,
 * CoAP PSKs). The read-echo leak is closed by GraphQL redaction (SENSOR-HIGH-081);
 * this closes the residual at-rest / backup-leak vector by encrypting ONLY the
 * secret-named fields with AES-256-GCM. Non-secret fields (topic, host, …) stay
 * plaintext, so the `protocol_configuration->>'topic'` index + MQTT hot path keep
 * working. Uses the same process-wide `CredentialVaultService`
 * (`CREDENTIAL_ENCRYPTION_KEY`) as the string credential columns — one at-rest
 * crypto scheme in the service.
 */
export const EncryptedProtocolConfigTransformer: ValueTransformer = {
  to(value: ConfigValue): ConfigValue {
    return encryptProtocolConfig(value, getVaultInstance());
  },
  from(value: ConfigValue): ConfigValue {
    return decryptProtocolConfig(value, getVaultInstance());
  },
};
