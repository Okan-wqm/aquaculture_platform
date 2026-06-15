import { Resolver, ResolveField, Parent } from '@nestjs/graphql';
import { Logger } from '@nestjs/common';
import { Tenant } from '@aquaculture/backend-common/decorators';

import { MessageAttachment } from '../entities/message-attachment.entity';
import { MediaService } from '../services/media.service';

/**
 * Field resolver for {@link MessageAttachment} presigned URLs.
 *
 * WHY (MSG-CRITICAL-052 root cause): `downloadUrl` and `thumbnailUrl` were
 * declared as bare `@Field`s on the entity with NO resolver and NO backing
 * column, so GraphQL silently returned `null` for every attachment — every
 * uploaded image/file/voice note persisted correctly but could never be
 * displayed or played back. `MediaService.generateDownloadUrl` existed but was
 * never called (dead code).
 *
 * WHAT (tier-1 make-it-impossible): the two fields are now defined ONLY here
 * via `@ResolveField`. The bare entity properties were removed, so the GraphQL
 * schema field cannot exist without this resolver present — a future removal
 * is a schema break (clients get a validation error), not a silent null.
 *
 * SECURITY: the presigned URL is generated against the REQUESTING tenant
 * (`@Tenant()`, sourced from the JWT), not the attachment row's own tenantId.
 * `generateDownloadUrl` rejects any `storageKey` not prefixed
 * `messaging/{tenantId}/`, so a caller can never sign a cross-tenant object
 * even if a foreign attachment leaked into the parent message.
 */
@Resolver(() => MessageAttachment)
export class MessageAttachmentResolver {
  private readonly logger = new Logger(MessageAttachmentResolver.name);

  constructor(private readonly mediaService: MediaService) {}

  @ResolveField(() => String, {
    nullable: true,
    description: 'Presigned download URL for the attachment (tenant-scoped, expiring).',
  })
  async downloadUrl(
    @Parent() attachment: MessageAttachment,
    @Tenant() tenantId: string,
  ): Promise<string | null> {
    if (!attachment.storageKey) {
      return null;
    }
    try {
      return await this.mediaService.generateDownloadUrl(tenantId, attachment.storageKey);
    } catch (error) {
      // A cross-tenant storageKey (ForbiddenException) or transient S3 failure
      // resolves to null rather than failing the whole message query.
      this.logger.warn(
        `downloadUrl resolution failed for attachment ${attachment.id}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  @ResolveField(() => String, {
    nullable: true,
    description: 'Presigned thumbnail URL for image/video attachments (tenant-scoped, expiring).',
  })
  async thumbnailUrl(
    @Parent() attachment: MessageAttachment,
    @Tenant() tenantId: string,
  ): Promise<string | null> {
    if (!attachment.thumbnailKey) {
      return null;
    }
    try {
      return await this.mediaService.generateDownloadUrl(tenantId, attachment.thumbnailKey);
    } catch (error) {
      this.logger.warn(
        `thumbnailUrl resolution failed for attachment ${attachment.id}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
