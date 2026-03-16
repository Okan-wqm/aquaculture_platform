import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CredentialVaultService } from './credential-vault.service';
import { setVaultInstance } from './credential.transformer';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [CredentialVaultService],
  exports: [CredentialVaultService],
})
export class CredentialVaultModule implements OnModuleInit {
  constructor(private readonly vault: CredentialVaultService) {}

  onModuleInit(): void {
    setVaultInstance(this.vault);
  }
}
