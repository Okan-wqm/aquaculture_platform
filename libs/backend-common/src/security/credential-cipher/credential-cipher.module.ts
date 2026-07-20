import { Module } from '@nestjs/common';

import { CredentialCipherService } from './credential-cipher.service';

/** Explicit opt-in module; importing it makes invalid key configuration fatal. */
@Module({
  providers: [CredentialCipherService],
  exports: [CredentialCipherService],
})
export class CredentialCipherModule {}
