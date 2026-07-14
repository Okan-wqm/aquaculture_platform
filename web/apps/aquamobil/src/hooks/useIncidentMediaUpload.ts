// ============================================================================
// useIncidentMediaUpload — farm incident photo upload (presign → PUT → key)
// ============================================================================

/**
 * WHY: The three regulatory incident pages (escape / welfare / lice) let a field
 * worker attach photos to the record they are filing. This hook is the
 * upload-at-capture path: while ONLINE it turns a picked photo into a durable
 * MinIO object and returns its storageKey, which the page threads into the
 * record's `mediaKeys`. The record itself still flows through the offline queue;
 * only the binary upload requires connectivity (see PhotoCaptureField, which
 * blocks capture when offline).
 *
 * The flow mirrors useMediaUpload (messaging): request a presigned PUT URL from
 * the farm-service `requestIncidentMediaUpload` mutation, then PUT the bytes
 * directly to MinIO via XHR (progress-capable). Images over the compression
 * threshold are canvas-downscaled first, exactly as the messaging lane does.
 *
 * Scope: only the upload-at-capture path. Capture-offline-upload-on-sync (a
 * binary blob lane replayed by the SW, like messaging's uploadAndSendMessage)
 * is NOT built here — it is the remaining enhancement.
 *
 * GraphQL note: the `requestIncidentMediaUpload` document is hand-written and
 * colocated here (not under src/graphql/**), so graphql-codegen does not pluck
 * it — the same convention useTanks uses for its farm-service query. The result
 * shape is pinned via the explicit-result overload of graphqlRequest, so a
 * response drift is a compile error at this call site.
 */

import { gql } from 'graphql-tag';
import { useCallback, useRef, useState } from 'react';

import { graphqlRequest } from '@/services/authenticated-fetch';

/** Incident category — mirrors the backend `IncidentMediaType` enum. */
export type IncidentMediaType = 'ESCAPE' | 'WELFARE' | 'LICE';

/**
 * Images-only client allowlist. Incident photos are visual evidence, so only
 * raster image formats are accepted. This is a fast fail-first UX check; the
 * server's presign handler remains the enforcing boundary. `image/svg+xml` is
 * deliberately absent (stored-XSS vector).
 */
export const INCIDENT_MEDIA_MIME_ALLOWLIST = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

const ALLOWED_MIME_TYPES = new Set<string>(INCIDENT_MEDIA_MIME_ALLOWLIST);

/** Client-side size cap: 10 MB (a large field photo compresses well below this). */
export const MAX_INCIDENT_MEDIA_BYTES = 10 * 1024 * 1024;

/** Threshold above which images are canvas-downscaled before upload. */
const COMPRESSION_THRESHOLD = 2 * 1024 * 1024; // 2 MB

/** Target size after compression. */
const COMPRESSION_TARGET = 1.5 * 1024 * 1024; // 1.5 MB

/** Response shape of the `requestIncidentMediaUpload` mutation. */
interface IncidentMediaUploadResponse {
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
}

/**
 * Presigned-upload request. tenantId/userId come from the JWT via backend
 * decorators, never as variables — the same convention as every other mobile
 * operation.
 */
const REQUEST_INCIDENT_MEDIA_UPLOAD = gql`
  mutation RequestIncidentMediaUpload($input: RequestIncidentMediaUploadInput!) {
    requestIncidentMediaUpload(input: $input) {
      uploadUrl
      storageKey
      expiresAt
    }
  }
`;

/**
 * Compress an image file using a canvas resize. Returns the original file when
 * compression is not applicable (non JPEG/PNG) or does not help. Mirrors the
 * messaging lane so the two upload paths behave identically.
 */
async function compressImage(file: File): Promise<Blob> {
  // Only JPEG and PNG re-encode cleanly via canvas.toBlob.
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    return file;
  }

  return new Promise<Blob>((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = (): void => {
      URL.revokeObjectURL(url);

      const ratio = Math.sqrt(COMPRESSION_TARGET / file.size);
      const targetWidth = Math.round(img.width * Math.min(ratio, 1));
      const targetHeight = Math.round(img.height * Math.min(ratio, 1));

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(file);
        return;
      }

      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      canvas.toBlob(
        (blob) => {
          if (blob && blob.size < file.size) {
            resolve(blob);
          } else {
            resolve(file); // Compression didn't help — keep the original.
          }
        },
        file.type === 'image/png' ? 'image/png' : 'image/jpeg',
        0.8, // JPEG quality
      );
    };

    img.onerror = (): void => {
      URL.revokeObjectURL(url);
      resolve(file); // Decode failed — keep the original.
    };

    img.src = url;
  });
}

/**
 * PUT a blob to a presigned URL with progress tracking.
 */
function uploadToPresignedUrl(
  presignedUrl: string,
  blob: Blob,
  mimeType: string,
  onProgress: (percent: number) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Upload failed: network error'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload cancelled'));
    });

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.open('PUT', presignedUrl);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.send(blob);
  });
}

/** Return shape of {@link useIncidentMediaUpload}. */
export interface UseIncidentMediaUploadReturn {
  /**
   * Upload a photo for an incident; resolves to the MinIO storageKey to thread
   * into the record's `mediaKeys`.
   * @throws Error when the file is not an allowed image, exceeds the size cap,
   *         or the presign/PUT fails.
   */
  uploadPhoto: (file: File, incidentType: IncidentMediaType) => Promise<string>;
  /** True while an upload is in flight. */
  isUploading: boolean;
  /** Upload progress, 0-100. */
  progress: number;
  /** The last upload error, or null. */
  error: Error | null;
}

/**
 * Incident photo upload hook. Stateless with respect to the record — it only
 * returns storageKeys; the page owns the collected key list.
 */
export function useIncidentMediaUpload(): UseIncidentMediaUploadReturn {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const uploadPhoto = useCallback(
    async (file: File, incidentType: IncidentMediaType): Promise<string> => {
      // Client-side MIME validation (images only).
      if (!ALLOWED_MIME_TYPES.has(file.type)) {
        throw new Error(
          file.type
            ? `File type ${file.type} is not a supported image (JPEG, PNG, or WebP)`
            : 'Unsupported file — only JPEG, PNG, or WebP images are allowed',
        );
      }

      // Client-side size validation.
      if (file.size > MAX_INCIDENT_MEDIA_BYTES) {
        throw new Error('Photo exceeds the 10 MB limit');
      }

      setIsUploading(true);
      setProgress(0);
      setError(null);
      abortControllerRef.current = new AbortController();

      try {
        // Step 0: compress large images.
        let uploadBlob: Blob = file;
        if (file.size > COMPRESSION_THRESHOLD && file.type.startsWith('image/')) {
          uploadBlob = await compressImage(file);
        }

        // Step 1: presigned PUT URL from farm-service.
        const result = await graphqlRequest<{
          requestIncidentMediaUpload: IncidentMediaUploadResponse;
        }>(REQUEST_INCIDENT_MEDIA_UPLOAD, {
          input: {
            incidentType,
            filename: file.name,
            mimeType: file.type,
            fileSize: uploadBlob.size,
          },
        });

        const { uploadUrl, storageKey } = result.requestIncidentMediaUpload;

        // Step 2: PUT the bytes directly to MinIO (NOT via /graphql).
        await uploadToPresignedUrl(
          uploadUrl,
          uploadBlob,
          file.type,
          setProgress,
          abortControllerRef.current.signal,
        );

        return storageKey;
      } catch (err) {
        const uploadError = err instanceof Error ? err : new Error('Upload failed');
        setError(uploadError);
        throw uploadError;
      } finally {
        setIsUploading(false);
        abortControllerRef.current = null;
      }
    },
    [],
  );

  return { uploadPhoto, isUploading, progress, error };
}
