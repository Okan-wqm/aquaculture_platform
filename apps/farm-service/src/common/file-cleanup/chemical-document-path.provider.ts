/**
 * ChemicalDocumentPathProvider
 *
 * `FileReferenceProvider` implementation for the chemical
 * documents JSONB array. Each entry shape:
 *
 *   { id, name, type, url, uploadedAt, uploadedBy }
 *
 * The `url` is stored as a full MinIO URL at upload time
 * (`http(s)://<host>:<port>/<bucket>/tenantId/.../file.pdf`) —
 * not as a bucket-relative object name. The orphan cleanup
 * service, in contrast, operates on object names (what MinIO
 * `listObjects` returns). This provider translates by stripping
 * everything up to and including the `/<bucket>/` boundary.
 *
 * # Safety posture on URL parsing failures
 *
 * A URL that doesn't contain the bucket segment (a CDN-routed
 * URL, a pre-migration record, an external reference) is
 * SKIPPED rather than speculatively returned as a path. The
 * consequence: objects whose reference we can't parse are
 * treated as "no provider claims this path" and — if nothing
 * else references them — they become cleanup candidates. To
 * avoid deleting a live file this way, we rely on the orphan
 * cleanup service's age gate (default 24h): a file whose URL
 * shape changes must spend a full day outside any provider
 * claim before deletion. In practice legitimate URL-shape
 * drift is caught by monitoring the `deleted` count on the
 * nightly cron.
 *
 * Phase 6.2.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Chemical, ChemicalDocument } from '../../chemical/entities/chemical.entity';
import { FileReferenceProvider } from './file-reference-provider';

@Injectable()
export class ChemicalDocumentPathProvider implements FileReferenceProvider {
  private readonly logger = new Logger(ChemicalDocumentPathProvider.name);
  readonly name = 'Chemical.documents[].url';

  constructor(
    @InjectRepository(Chemical)
    private readonly repo: Repository<Chemical>,
    /**
     * Bucket name injected by the caller (farm-service passes the
     * same value the MinIO client was configured with). Keeps the
     * provider free of its own STORAGE_CONFIG dependency and
     * makes tests trivial.
     */
    private readonly bucket: string,
  ) {}

  async collectLivePaths(): Promise<string[]> {
    const rows = await this.repo
      .createQueryBuilder('c')
      .select('c.documents', 'documents')
      .where('c.documents IS NOT NULL')
      .getRawMany<{ documents: ChemicalDocument[] | null }>();

    const paths: string[] = [];
    let skipped = 0;
    for (const row of rows) {
      if (!row.documents) continue;
      for (const doc of row.documents) {
        if (!doc?.url) continue;
        const objectName = this.extractObjectName(doc.url);
        if (objectName) {
          paths.push(objectName);
        } else {
          skipped += 1;
        }
      }
    }
    if (skipped > 0) {
      this.logger.warn(
        `${skipped} chemical document URL(s) did not contain the bucket ` +
          `prefix '/${this.bucket}/' — not contributed to the live-paths ` +
          'set. Nightly cron age-gate (default 24h) prevents incidental ' +
          'deletion.',
      );
    }
    return paths;
  }

  /**
   * Strip everything up to and including `/${bucket}/` from a
   * full MinIO URL. Returns `null` if the bucket segment is
   * absent (the provider then treats the reference as unparseable
   * — see safety posture in the file header).
   */
  private extractObjectName(url: string): string | null {
    const marker = `/${this.bucket}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) return null;
    const rest = url.slice(idx + marker.length);
    // Drop any query-string / fragment — presigned URLs often carry them.
    const clean = rest.split('?')[0]?.split('#')[0] ?? '';
    return clean.length > 0 ? clean : null;
  }
}
