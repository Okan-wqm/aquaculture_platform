/**
 * Document Upload Section Component
 * Handles file uploads for batch documents (health certificates, import documents)
 */
import React, { useRef, useState, useCallback } from 'react';
import { useToast, Spinner, Button, Input } from '@aquaculture/shared-ui';
import { validateDocumentFile, formatFileSize } from '../../../hooks/useFileUpload';
import type { BatchDocumentInput, BatchDocumentType } from '../../../hooks/useBatches';
import type { UploadedDocument } from '../../../hooks/useFileUpload';
import {
  CircleCheck,
  CloudUpload,
  File as FileIcon,
  FileChartColumn,
  Image,
  Plus,
  X,
} from 'lucide-react';

interface LocalDocument {
  id: string; // temporary ID for local management
  file?: File;
  documentName: string;
  documentNumber?: string;
  documentType: BatchDocumentType;
  // If uploaded, these will be filled
  storagePath?: string;
  storageUrl?: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  issueDate?: string;
  expiryDate?: string;
  issuingAuthority?: string;
  // Status
  isUploaded: boolean;
  isUploading: boolean;
  uploadError?: string;
}

interface DocumentUploadSectionProps {
  title: string;
  documentType: BatchDocumentType;
  documents: LocalDocument[];
  onDocumentsChange: (docs: LocalDocument[]) => void;
  onUpload: (
    file: File,
    documentName: string,
    documentNumber?: string,
  ) => Promise<UploadedDocument>;
  required?: boolean;
  maxDocuments?: number;
}

export const DocumentUploadSection: React.FC<DocumentUploadSectionProps> = ({
  title,
  documentType,
  documents,
  onDocumentsChange,
  onUpload,
  required = false,
  maxDocuments = 10,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [newDocName, setNewDocName] = useState('');
  const [newDocNumber, setNewDocNumber] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const { toast } = useToast();

  const handleFileSelect = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;

      const file = files[0];
      const validation = validateDocumentFile(file);

      if (!validation.valid) {
        toast({
          title: 'Invalid File',
          description: validation.error || 'Invalid file type or size.',
          variant: 'error',
        });
        return;
      }

      if (documents.length >= maxDocuments) {
        toast({
          title: 'Limit Reached',
          description: `Maximum ${maxDocuments} documents allowed.`,
          variant: 'error',
        });
        return;
      }

      // Create local document entry
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const newDoc: LocalDocument = {
        id: tempId,
        file,
        documentName: newDocName || file.name.replace(/\.[^/.]+$/, ''),
        documentNumber: newDocNumber || undefined,
        documentType,
        originalFilename: file.name,
        mimeType: file.type,
        fileSize: file.size,
        isUploaded: false,
        isUploading: true,
      };

      // Add to list with uploading status
      onDocumentsChange([...documents, newDoc]);

      // Reset form
      setNewDocName('');
      setNewDocNumber('');
      setShowAddForm(false);

      try {
        // Upload the file
        const result = await onUpload(file, newDoc.documentName, newDoc.documentNumber);

        // Update the document with upload result
        onDocumentsChange(
          documents.map((d) =>
            d.id === tempId
              ? {
                  ...d,
                  storagePath: result.storagePath,
                  storageUrl: result.storageUrl,
                  isUploaded: true,
                  isUploading: false,
                }
              : d,
          ),
        );
      } catch (error) {
        // Update with error status
        onDocumentsChange(
          documents.map((d) =>
            d.id === tempId
              ? {
                  ...d,
                  isUploading: false,
                  uploadError: error instanceof Error ? error.message : 'Upload failed',
                }
              : d,
          ),
        );
      }

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [documents, documentType, maxDocuments, newDocName, newDocNumber, onDocumentsChange, onUpload],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleFileSelect(e.dataTransfer.files);
    },
    [handleFileSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleRemoveDocument = (docId: string) => {
    onDocumentsChange(documents.filter((d) => d.id !== docId));
  };

  const handleRetryUpload = async (doc: LocalDocument) => {
    if (!doc.file) return;

    // Mark as uploading
    onDocumentsChange(
      documents.map((d) =>
        d.id === doc.id ? { ...d, isUploading: true, uploadError: undefined } : d,
      ),
    );

    try {
      const result = await onUpload(doc.file, doc.documentName, doc.documentNumber);

      onDocumentsChange(
        documents.map((d) =>
          d.id === doc.id
            ? {
                ...d,
                storagePath: result.storagePath,
                storageUrl: result.storageUrl,
                isUploaded: true,
                isUploading: false,
              }
            : d,
        ),
      );
    } catch (error) {
      onDocumentsChange(
        documents.map((d) =>
          d.id === doc.id
            ? {
                ...d,
                isUploading: false,
                uploadError: error instanceof Error ? error.message : 'Upload failed',
              }
            : d,
        ),
      );
    }
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.includes('pdf')) {
      return <FileChartColumn className="w-8 h-8 text-red-500" aria-hidden="true" />;
    }
    if (mimeType.includes('image')) {
      return <Image className="w-8 h-8 text-green-500" aria-hidden="true" />;
    }
    return <FileIcon className="w-8 h-8 text-blue-500" aria-hidden="true" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {title} {required && <span className="text-red-500">*</span>}
        </h4>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {documents.length}/{maxDocuments} documents
        </span>
      </div>

      {/* Document List */}
      {documents.length > 0 && (
        <div className="space-y-2">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className={`flex items-center justify-between p-3 rounded-lg border ${
                doc.uploadError
                  ? 'border-red-300 bg-red-50'
                  : doc.isUploading
                    ? 'border-yellow-300 bg-yellow-50'
                    : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800'
              }`}
            >
              <div className="flex items-center space-x-3">
                {getFileIcon(doc.mimeType)}
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {doc.documentName}
                  </p>
                  <div className="flex items-center space-x-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>{doc.originalFilename}</span>
                    <span>-</span>
                    <span>{formatFileSize(doc.fileSize)}</span>
                    {doc.documentNumber && (
                      <>
                        <span>-</span>
                        <span>#{doc.documentNumber}</span>
                      </>
                    )}
                  </div>
                  {doc.uploadError && (
                    <p className="text-xs text-red-600 mt-1">{doc.uploadError}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-2">
                {doc.isUploading && <Spinner size="md" />}
                {doc.isUploaded && (
                  <CircleCheck className="h-5 w-5 text-green-600" aria-hidden="true" />
                )}
                {doc.uploadError && (
                  <Button
                    variant="ghost"
                    size="xs"
                    type="button"
                    onClick={() => handleRetryUpload(doc)}
                  >
                    Retry
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => handleRemoveDocument(doc.id)}
                  title="Remove document"
                >
                  <X className="w-5 h-5" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Document Form */}
      {showAddForm ? (
        <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Document Name <span className="text-red-500">*</span>
              </label>
              <Input
                fullWidth
                type="text"
                value={newDocName}
                onChange={(e) => setNewDocName(e.target.value)}
                placeholder="e.g., Health Certificate 2024"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Document Number
              </label>
              <Input
                fullWidth
                type="text"
                value={newDocNumber}
                onChange={(e) => setNewDocNumber(e.target.value)}
                placeholder="e.g., HC-2024-001"
              />
            </div>
          </div>

          {/* File Drop Zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
              dragOver
                ? 'border-blue-400 bg-blue-50'
                : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
              onChange={(e) => handleFileSelect(e.target.files)}
              className="hidden"
            />
            <CloudUpload
              className="mx-auto h-10 w-10 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              <Button variant="ghost" type="button" onClick={() => fileInputRef.current?.click()}>
                Choose file
              </Button>{' '}
              or drag and drop
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              PDF, DOC, PNG, JPG up to 15MB
            </p>
          </div>

          <div className="flex justify-end space-x-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setNewDocName('');
                setNewDocNumber('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        documents.length < maxDocuments && (
          <Button variant="secondary" type="button" onClick={() => setShowAddForm(true)}>
            <span className="flex items-center justify-center">
              <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
              Add Document
            </span>
          </Button>
        )
      )}
    </div>
  );
};

export default DocumentUploadSection;

// Helper to convert LocalDocument to BatchDocumentInput for API
export function toDocumentInput(doc: LocalDocument): BatchDocumentInput | null {
  if (!doc.isUploaded || !doc.storagePath || !doc.storageUrl) {
    return null;
  }
  return {
    documentType: doc.documentType,
    documentName: doc.documentName,
    documentNumber: doc.documentNumber,
    storagePath: doc.storagePath,
    storageUrl: doc.storageUrl,
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    fileSize: doc.fileSize,
    issueDate: doc.issueDate,
    expiryDate: doc.expiryDate,
    issuingAuthority: doc.issuingAuthority,
  };
}
