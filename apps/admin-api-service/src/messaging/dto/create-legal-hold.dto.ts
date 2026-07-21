import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Body for `POST /messaging/compliance/legal-holds`.
 *
 * A class (not a TS interface) so the global ValidationPipe
 * (`whitelist` + `forbidNonWhitelisted` + `transform`) actually engages: a
 * missing `reason`/`legalMatterId` or a non-UUID `tenantId` is rejected with a
 * non-retried 400 at the REST edge instead of travelling over NATS to fail deep
 * in messaging-service and surface as a retried 502 (APA-179). The acting
 * SUPER_ADMIN (`userId`) is sourced from the JWT, never the body.
 */
export class CreateLegalHoldDto {
  @IsUUID('4')
  tenantId!: string;

  /** Channel-scoped hold; `null`/omitted means a tenant-wide hold. */
  @IsOptional()
  @IsUUID('4')
  channelId?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  legalMatterId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  legalMatterDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  requestedBy?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
