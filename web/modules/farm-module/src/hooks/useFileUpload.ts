/**
 * File Upload hooks for farm-module
 * Handles file uploads for batch documents via REST API
 */
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@aquaculture/shared-ui';

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

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

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

      const response = await fetch(`${API_BASE_URL}/upload/batch-document`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-tenant-id': tenantId,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Upload failed' }));
        throw new Error(error.message || `Upload failed with status ${response.status}`);
      }

      return response.json();
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

      const response = await fetch(
        `${API_BASE_URL}/upload/batch-document/${input.entityId}/${input.documentId}/${input.filename}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'x-tenant-id': tenantId,
          },
        }
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Delete failed' }));
        throw new Error(error.message || `Delete failed with status ${response.status}`);
      }

      return response.json();
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

  if (!allowedTypes.includes(file.type)) {
    // Some browsers may not set correct mime type, so we check extension as fallback
    console.warn(`MIME type ${file.type} not in allowed list, but extension ${extension} is valid`);
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
