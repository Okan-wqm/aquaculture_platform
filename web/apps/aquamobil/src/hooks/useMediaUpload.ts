// ============================================================================
// useMediaUpload — Media upload hook with presigned URL, progress, and compression
// ============================================================================

/**
 * WHY: Provides a two-step media upload flow:
 *   1. Call requestMediaUpload mutation to get a presigned MinIO PUT URL
 *   2. Upload directly to MinIO via XMLHttpRequest (for progress tracking)
 *
 * Includes client-side image compression for files > 2MB using canvas resize,
 * MIME type validation, and progress percentage tracking.
 *
 * @returns uploadMedia — function to upload a file, returns storageKey on success
 * @returns isUploading — true while upload is in flight
 * @returns progress — upload progress 0-100
 * @returns error — upload error, if any
 */

import { MESSAGING_MEDIA_MIME_ALLOWLIST } from '@aquaculture/shared-contracts';
import { useState, useCallback, useRef } from 'react';

import { REQUEST_MEDIA_UPLOAD } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { MediaUploadResponse } from '@/types/messaging';

/** Maximum file size: 25 MB (matches backend validation). */
const MAX_FILE_SIZE = 26_214_400;

/** Threshold above which images are compressed before upload. */
const COMPRESSION_THRESHOLD = 2 * 1024 * 1024; // 2 MB

/** Target size after compression. */
const COMPRESSION_TARGET = 1.5 * 1024 * 1024; // 1.5 MB

/**
 * Allowed MIME types for upload — client-side UX pre-flight check.
 *
 * MSG-MEDIUM-057: built from the single shared allowlist SSoT
 * (`MESSAGING_MEDIA_MIME_ALLOWLIST`), the SAME list the server's media.service
 * enforces. The previous hand-maintained client list had silently drifted: it
 * wrongly allowed `image/svg+xml` (a stored-XSS vector the server rejected) and
 * was missing the archive/office MIMEs the server accepted. Adopting the SSoT
 * removes both directions of drift; the server stays the enforcing boundary.
 */
const ALLOWED_MIME_TYPES = new Set<string>(MESSAGING_MEDIA_MIME_ALLOWLIST);

/**
 * Compress an image file using canvas resize.
 * Returns the original file if compression is not possible or not needed.
 *
 * @param file - The image file to compress
 * @returns Compressed blob (or original file if compression failed)
 */
async function compressImage(file: File): Promise<Blob> {
  // Only compress JPEG and PNG
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    return file;
  }

  return new Promise<Blob>((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      // Calculate scale factor to approximate target size
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
            resolve(file); // Compression didn't help — use original
          }
        },
        file.type === 'image/png' ? 'image/png' : 'image/jpeg',
        0.8, // JPEG quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file); // Image decode failed — use original
    };

    img.src = url;
  });
}

/**
 * Upload a blob to a presigned URL with progress tracking.
 *
 * @param presignedUrl - The presigned PUT URL from requestMediaUpload
 * @param blob - The file content to upload
 * @param mimeType - The MIME type for the Content-Type header
 * @param onProgress - Progress callback (0-100)
 * @param abortSignal - Optional AbortSignal for cancellation
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
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress(percent);
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

/** Return shape of {@link useMediaUpload}. */
export interface UseMediaUploadReturn {
  /** Upload a file; resolves to the storageKey for sendMessage attachmentKeys. */
  uploadMedia: (file: File) => Promise<string>;
  /** Abort an in-progress upload. */
  cancelUpload: () => void;
  /** True while an upload is in flight. */
  isUploading: boolean;
  /** Upload progress, 0-100. */
  progress: number;
  /** The last upload error, or null. */
  error: Error | null;
}

/**
 * Media upload hook with presigned URL, progress tracking, image compression,
 * and MIME type validation.
 *
 * @param channelId - The channel this upload belongs to (required for the
 *                    presigned URL request). Pass undefined to disable.
 */
export function useMediaUpload(channelId: string | undefined): UseMediaUploadReturn {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Upload a file to the messaging media storage.
   *
   * @param file - The File object to upload
   * @returns storageKey to reference in sendMessage attachmentKeys
   * @throws Error if validation fails, upload fails, or channelId is missing
   */
  const uploadMedia = useCallback(
    async (file: File): Promise<string> => {
      if (!channelId) {
        throw new Error('No channel selected for upload');
      }

      // Client-side MIME validation
      if (!ALLOWED_MIME_TYPES.has(file.type)) {
        throw new Error(`File type ${file.type} is not allowed`);
      }

      // Client-side size validation
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`File exceeds maximum size of 25 MB`);
      }

      setIsUploading(true);
      setProgress(0);
      setError(null);
      abortControllerRef.current = new AbortController();

      try {
        // Step 0: Compress images > 2MB
        let uploadBlob: Blob = file;
        if (
          file.size > COMPRESSION_THRESHOLD &&
          file.type.startsWith('image/')
        ) {
          uploadBlob = await compressImage(file);
        }

        // Step 1: Get presigned URL from backend
        const result = await graphqlRequest<{
          requestMediaUpload: MediaUploadResponse;
        }>(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: file.name,
            mimeType: file.type,
            fileSize: uploadBlob.size,
          },
        });

        const { uploadUrl, storageKey } = result.requestMediaUpload;

        // Step 2: Upload directly to MinIO
        await uploadToPresignedUrl(
          uploadUrl,
          uploadBlob,
          file.type,
          setProgress,
          abortControllerRef.current.signal,
        );

        return storageKey;
      } catch (err) {
        const uploadError =
          err instanceof Error ? err : new Error('Upload failed');
        setError(uploadError);
        throw uploadError;
      } finally {
        setIsUploading(false);
        abortControllerRef.current = null;
      }
    },
    [channelId],
  );

  /**
   * Cancel an in-progress upload.
   */
  const cancelUpload = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  return {
    uploadMedia,
    cancelUpload,
    isUploading,
    progress,
    error,
  };
}
