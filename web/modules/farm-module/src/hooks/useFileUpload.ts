/**
 * File Upload hooks for farm-module
 * Handles file uploads for batch documents via REST API
 */
import { useMutation } from '@tanstack/react-query';
import { useAuth, restClient } from '@aquaculture/shared-ui';

// Types
export type BatchDocumentCategory = 'health_certificate' | 'import_document' | 'other';

export interface UploadedDocument {
  documentId: string;
  storagePath: string;
  storageUrl: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: string;
}

export interface UploadBatchDocumentInput {
  file: File;
  documentName: string;
  documentCategory: BatchDocumentCategory;
  documentNumber?: string;
  entityId?: string; // Optional: associate with existing batch
}

export interface DeleteDocumentInput {
  entityId: string;
  documentId: string;
  filename: string;
}

/**
 * Hook to upload batch document
 */
export function useUploadBatchDocument() {
  const { token, tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: UploadBatchDocumentInput): Promise<UploadedDocument> => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }

      const formData = new FormData();
      formData.append('file', input.file);
      formData.append('documentName', input.documentName);
      formData.append('documentCategory', input.documentCategory);
      if (input.documentNumber) {
        formData.append('documentNumber', input.documentNumber);
      }
      if (input.entityId) {
        formData.append('entityId', input.entityId);
      }

      // FARM-MEDIUM-091: route through the shared restClient so auth, tenant,
      // CSRF, the lifecycle barrier and 401-refresh are applied uniformly. The
      // FormData body is detected and passed through as multipart (the browser
      // sets the boundary); restClient throws RestClientError on a non-2xx.
      return restClient.request<UploadedDocument>('POST', '/upload/batch-document', {
        body: formData,
      });
    },
  });
}

/**
 * Hook to delete batch document
 */
export function useDeleteBatchDocument() {
  const { token, tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: DeleteDocumentInput): Promise<{ success: boolean }> => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }

      // FARM-MEDIUM-091: shared restClient (auth + tenant + CSRF + 401-refresh).
      return restClient.delete<{ success: boolean }>(
        `/upload/batch-document/${encodeURIComponent(input.entityId)}/${encodeURIComponent(input.documentId)}/${encodeURIComponent(input.filename)}`
      );
    },
  });
}

/**
 * Custom hook for managing multiple document uploads
 */
export function useDocumentUploadManager() {
  const uploadMutation = useUploadBatchDocument();
  const deleteMutation = useDeleteBatchDocument();

  const uploadMultiple = async (
    files: { file: File; documentName: string; documentNumber?: string }[],
    category: BatchDocumentCategory,
    entityId?: string
  ): Promise<UploadedDocument[]> => {
    const results: UploadedDocument[] = [];

    for (const { file, documentName, documentNumber } of files) {
      const result = await uploadMutation.mutateAsync({
        file,
        documentName,
        documentCategory: category,
        documentNumber,
        entityId,
      });
      results.push(result);
    }

    return results;
  };

  return {
    upload: uploadMutation.mutateAsync,
    uploadMultiple,
    delete: deleteMutation.mutateAsync,
    isUploading: uploadMutation.isPending,
    isDeleting: deleteMutation.isPending,
    uploadError: uploadMutation.error,
    deleteError: deleteMutation.error,
    reset: () => {
      uploadMutation.reset();
      deleteMutation.reset();
    },
  };
}

// Helper function to validate file before upload
export function validateDocumentFile(file: File): { valid: boolean; error?: string } {
  const maxSize = 15 * 1024 * 1024; // 15MB
  const allowedTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
    'image/jpg',
  ];
  const allowedExtensions = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg'];

  if (file.size > maxSize) {
    return { valid: false, error: `File size exceeds maximum allowed (15MB). File size: ${(file.size / 1024 / 1024).toFixed(2)}MB` };
  }

  const extension = '.' + file.name.split('.').pop()?.toLowerCase();
  if (!allowedExtensions.includes(extension)) {
    return { valid: false, error: `Invalid file type. Allowed: ${allowedExtensions.join(', ')}` };
  }

  if (file.type && !allowedTypes.includes(file.type)) {
    // Browser provided a MIME type but it is not in the allow-list — reject
    return { valid: false, error: `Invalid file type (${file.type}). Allowed: ${allowedExtensions.join(', ')}` };
  }

  return { valid: true };
}

// Helper function to format file size
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
