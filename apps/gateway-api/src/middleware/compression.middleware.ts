/**
 * Compression Middleware
 *
 * Compresses response bodies using gzip or brotli compression.
 * Supports configurable compression threshold and content type filtering.
 * Improves bandwidth usage and response times for large payloads.
 */

import * as zlib from 'zlib';

import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';

/**
 * Compression configuration
 */
export interface CompressionConfig {
  threshold: number; // Minimum size to compress (bytes)
  level: number; // Compression level (1-9)
  memLevel: number; // Memory level (1-9)
  enableBrotli: boolean;
  enableGzip: boolean;
  enableDeflate: boolean;
  filter: (contentType: string) => boolean;
}

/**
 * Extended response with compression tracking
 */
interface CompressibleResponse extends Response {
  _originalWrite?: Response['write'];
  _originalEnd?: Response['end'];
  _compressionStream?: zlib.Gzip | zlib.BrotliCompress | zlib.Deflate;
  _chunks?: Buffer[];
  _isCompressing?: boolean;
}

/**
 * Compressible content types
 */
const COMPRESSIBLE_TYPES = [
  'text/html',
  'text/plain',
  'text/css',
  'text/javascript',
  'text/xml',
  'application/json',
  'application/javascript',
  'application/xml',
  'application/xhtml+xml',
  'application/rss+xml',
  'application/atom+xml',
  'image/svg+xml',
];

/**
 * Compression Middleware
 * Handles response compression
 */
@Injectable()
export class CompressionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CompressionMiddleware.name);
  private readonly config: CompressionConfig;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      threshold: this.configService.get<number>('COMPRESSION_THRESHOLD', 1024), // 1KB
      level: this.configService.get<number>('COMPRESSION_LEVEL', 6),
      memLevel: this.configService.get<number>('COMPRESSION_MEM_LEVEL', 8),
      enableBrotli: this.configService.get<boolean>('COMPRESSION_BROTLI', true),
      enableGzip: this.configService.get<boolean>('COMPRESSION_GZIP', true),
      enableDeflate: this.configService.get<boolean>('COMPRESSION_DEFLATE', false),
      filter: (contentType: string) => this.isCompressible(contentType),
    };
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const compressibleRes = res as CompressibleResponse;

    // Skip if no Accept-Encoding header
    const acceptEncoding = req.headers['accept-encoding'] as string;
    if (!acceptEncoding) {
      return next();
    }

    // Determine compression method
    const encoding = this.selectEncoding(acceptEncoding);
    if (!encoding) {
      return next();
    }

    // Track response chunks
    compressibleRes._chunks = [];
    compressibleRes._isCompressing = false;

    // Store original methods
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    // Override write method
    compressibleRes.write = function (
      chunk: unknown,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean {
      if (chunk) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as string, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8');
        compressibleRes._chunks!.push(buffer);
      }
      return true;
    };

    // Override end method
    compressibleRes.end = function (
      chunk?: unknown,
      encodingOrCallback?: BufferEncoding | (() => void),
      callback?: () => void,
    ): Response {
      if (chunk) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as string, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8');
        compressibleRes._chunks!.push(buffer);
      }

      // Combine all chunks
      const body = Buffer.concat(compressibleRes._chunks || []);

      // Check if compression should be applied
      const contentType = res.getHeader('Content-Type') as string || '';
      const threshold = (res as unknown as { _compressionThreshold?: number })._compressionThreshold || 1024;
      const shouldCompress = body.length >= threshold && isCompressibleType(contentType);

      if (!shouldCompress || body.length < 1024) {
        // Send uncompressed
        res.removeHeader('Content-Encoding');
        originalWrite(body);
        return originalEnd();
      }

      // Compress the response
      try {
        let compressed: Buffer;
        let encodingHeader: string;

        if (encoding === 'br') {
          compressed = zlib.brotliCompressSync(body, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
            },
          });
          encodingHeader = 'br';
        } else if (encoding === 'gzip') {
          compressed = zlib.gzipSync(body, { level: 6 });
          encodingHeader = 'gzip';
        } else {
          compressed = zlib.deflateSync(body, { level: 6 });
          encodingHeader = 'deflate';
        }

        // Only use compression if it actually reduces size
        if (compressed.length < body.length) {
          res.setHeader('Content-Encoding', encodingHeader);
          res.setHeader('Content-Length', compressed.length);
          res.setHeader('Vary', 'Accept-Encoding');
          originalWrite(compressed);
        } else {
          // Compression didn't help, send original
          res.setHeader('Content-Length', body.length);
          originalWrite(body);
        }
      } catch (error) {
        // On error, send uncompressed
        res.setHeader('Content-Length', body.length);
        originalWrite(body);
      }

      return originalEnd();
    };

    // Store compression threshold on response
    (compressibleRes as unknown as { _compressionThreshold: number })._compressionThreshold =
      this.config.threshold;

    next();
  }

  /**
   * Select best compression encoding
   */
  private selectEncoding(acceptEncoding: string): string | null {
    const encodings = acceptEncoding.toLowerCase().split(',').map((e) => e.trim());

    // Prefer Brotli if available and enabled
    if (this.config.enableBrotli && encodings.some((e) => e.startsWith('br'))) {
      return 'br';
    }

    // Then Gzip
    if (this.config.enableGzip && encodings.some((e) => e.startsWith('gzip'))) {
      return 'gzip';
    }

    // Finally Deflate
    if (this.config.enableDeflate && encodings.some((e) => e.startsWith('deflate'))) {
      return 'deflate';
    }

    return null;
  }

  /**
   * Check if content type is compressible
   */
  private isCompressible(contentType: string): boolean {
    if (!contentType) return false;

    const typePart = contentType.split(';')[0];
    if (!typePart) return false;

    const type = typePart.trim().toLowerCase();
    return COMPRESSIBLE_TYPES.some((t) => type.includes(t));
  }
}

/**
 * Check if content type is compressible (standalone function)
 */
function isCompressibleType(contentType: string): boolean {
  if (!contentType) return false;

  const typePart = contentType.split(';')[0];
  if (!typePart) return false;

  const type = typePart.trim().toLowerCase();
  return COMPRESSIBLE_TYPES.some((t) => type.includes(t));
}

/**
 * Compress data with specified encoding
 */
export async function compress(
  data: Buffer,
  encoding: 'gzip' | 'br' | 'deflate',
  options?: zlib.ZlibOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, result: Buffer) => {
      if (error) reject(error);
      else resolve(result);
    };

    switch (encoding) {
      case 'br':
        zlib.brotliCompress(data, callback);
        break;
      case 'gzip':
        zlib.gzip(data, options || {}, callback);
        break;
      case 'deflate':
        zlib.deflate(data, options || {}, callback);
        break;
      default:
        resolve(data);
    }
  });
}

/**
 * Decompress data with specified encoding
 */
export async function decompress(
  data: Buffer,
  encoding: 'gzip' | 'br' | 'deflate',
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, result: Buffer) => {
      if (error) reject(error);
      else resolve(result);
    };

    switch (encoding) {
      case 'br':
        zlib.brotliDecompress(data, callback);
        break;
      case 'gzip':
        zlib.gunzip(data, callback);
        break;
      case 'deflate':
        zlib.inflate(data, callback);
        break;
      default:
        resolve(data);
    }
  });
}
