import { Global, Module } from '@nestjs/common';

import {
  TOKEN_REVOCATION_READER,
  TokenRevocationReaderService,
} from './token-revocation-reader.service';

/**
 * Read-only revocation enforcement module for JWT-consuming boundaries.
 * RedisModule remains the owner of the mandatory distributed connection.
 */
@Global()
@Module({
  providers: [
    TokenRevocationReaderService,
    {
      provide: TOKEN_REVOCATION_READER,
      useExisting: TokenRevocationReaderService,
    },
  ],
  exports: [TOKEN_REVOCATION_READER],
})
export class TokenRevocationReaderModule {}
