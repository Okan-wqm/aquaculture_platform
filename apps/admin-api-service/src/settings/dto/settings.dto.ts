/**
 * Request bodies for `settings.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { IsEmail } from 'class-validator';

/**
 * System settings are READ here and owned by config-service (ORPHAN-HIGH-373):
 * every write went through a retired store and answered 410 Gone, so the
 * write routes are gone with it (ADMIN-HIGH-011). Only the env-backed reads,
 * the live SMTP test-send and the system-info summary remain.
 */
export class TestEmailConfigDto {
  @IsEmail()
  to!: string;
}
