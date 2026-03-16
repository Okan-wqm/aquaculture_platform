import { ValueTransformer } from 'typeorm';
import { CredentialVaultService } from './credential-vault.service';

// Static instance set during module init — TypeORM transformers can't use DI
let vaultInstance: CredentialVaultService | null = null;

export function setVaultInstance(vault: CredentialVaultService): void {
  vaultInstance = vault;
}

export const EncryptedColumnTransformer: ValueTransformer = {
  to(value: string | null | undefined): string | null | undefined {
    if (!value) return value;
    if (!vaultInstance) {
      console.error('[CredentialVault] SECURITY: Vault not initialized - refusing to store plaintext credential');
      throw new Error('CredentialVault not initialized - cannot store sensitive data');
    }
    if (vaultInstance.isEncrypted(value)) return value;
    return vaultInstance.encrypt(value);
  },
  from(value: string | null | undefined): string | null | undefined {
    if (!value) return value;
    if (!vaultInstance) {
      // During startup/migrations, vault may not be ready yet - return raw value
      return value;
    }
    try {
      return vaultInstance.decrypt(value);
    } catch (err) {
      console.error(`[CredentialVault] Decryption failed for value starting with "${value.substring(0, 10)}...":`, err);
      return '[DECRYPTION_FAILED]';
    }
  },
};
