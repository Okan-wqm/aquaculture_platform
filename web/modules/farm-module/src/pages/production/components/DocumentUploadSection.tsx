/**
 * Document Upload Section Component
 * Handles file uploads for batch documents (health certificates, import documents)
 */
import React, { useRef, useState, useCallback } from 'react';
import { validateDocumentFile, formatFileSize } from '../../../hooks/useFileUpload';
import type { BatchDocumentInput, BatchDocumentType } from '../../../hooks/useBatches';
import type { UploadedDocument } from '../../../hooks/useFileUpload';

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
  onUpload: (file: File, documentName: string, documentNumber?: string) => Promise<UploadedDocument>;
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

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const file = files[0];
    const validation = validateDocumentFile(file);

    if (!validation.valid) {
      alert(validation.error);
      return;
    }

    if (documents.length >= maxDocuments) {
      alert(`Maximum ${maxDocuments} documents allowed`);
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
        documents.map(d =>
          d.id === tempId
            ? {
                ...d,
                storagePath: result.storagePath,
                storageUrl: result.storageUrl,
                isUploaded: true,
                isUploading: false,
              }
            : d
        )
      );
    } catch (error) {
      // Update with error status
      onDocumentsChange(
        documents.map(d =>
          d.id === tempId
            ? {
                ...d,
                isUploading: false,
                uploadError: error instanceof Error ? error.message : 'Upload failed',
              }
            : d
        )
      );
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [documents, documentType, maxDocuments, newDocName, newDocNumber, onDocumentsChange, onUpload]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleRemoveDocument = (docId: string) => {
    onDocumentsChange(documents.filter(d => d.id !== docId));
  };

  const handleRetryUpload = async (doc: LocalDocument) => {
    if (!doc.file) return;

    // Mark as uploading
    onDocumentsChange(
      documents.map(d =>
        d.id === doc.id
          ? { ...d, isUploading: true, uploadError: undefined }
          : d
      )
    );

    try {
      const result = await onUpload(doc.file, doc.documentName, doc.documentNumber);

      onDocumentsChange(
        documents.map(d =>
          d.id === doc.id
            ? {
                ...d,
                storagePath: result.storagePath,
                storageUrl: result.storageUrl,
                isUploaded: true,
                isUploading: false,
              }
            : d
        )
      );
    } catch (error) {
      onDocumentsChange(
        documents.map(d =>
          d.id === doc.id
            ? {
                ...d,
                isUploading: false,
                uploadError: error instanceof Error ? error.message : 'Upload failed',
              }
            : d
        )
      );
    }
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.includes('pdf')) {
      return (
        <svg className="w-8 h-8 text-red-500" fill="currentColor" viewBox="0 0 24 24">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/>
          <path d="M8 12h2v5H8v-5zm3 0h2v5h-2v-5zm3 0h2v5h-2v-5z"/>
        </svg>
      );
    }
    if (mimeType.includes('image')) {
      return (
        <svg className="w-8 h-8 text-green-500" fill="currentColor" viewBox="0 0 24 24">
          <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM5 19V5h14v14H5zm4-4h6l-2-2.5-1.5 2L10 13l-1 2z"/>
        </svg>
      );
    }
    return (
      <svg className="w-8 h-8 text-blue-500" fill="currentColor" viewBox="0 0 24 24">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/>
      </svg>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700">
          {title} {required && <span className="text-red-500">*</span>}
        </h4>
        <span className="text-xs text-gray-500">
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
                  : 'border-gray-200 bg-gray-50'
              }`}
            >
              <div className="flex items-center space-x-3">
                {getFileIcon(doc.mimeType)}
                <div>
                  <p className="text-sm font-medium text-gray-900">{doc.documentName}</p>
                  <div className="flex items-center space-x-2 text-xs text-gray-500">
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
                {doc.isUploading && (
                  <svg className="animate-spin h-5 w-5 text-yellow-600" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                  </svg>
                )}
                {doc.isUploaded && (
                  <svg className="h-5 w-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
                  </svg>
                )}
                {doc.uploadError && (
                  <button
                    type="button"
                    onClick={() => handleRetryUpload(doc)}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleRemoveDocument(doc.id)}
                  className="p-1 text-gray-400 hover:text-red-600"
                  title="Remove document"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Document Form */}
      {showAddForm ? (
        <div className="p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Document Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={newDocName}
                onChange={(e) => setNewDocName(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="e.g., Health Certificate 2024"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Document Number
              </label>
              <input
                type="text"
                value={newDocNumber}
                onChange={(e) => setNewDocNumber(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                : 'border-gray-300 hover:border-gray-400'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
              onChange={(e) => handleFileSelect(e.target.files)}
              className="hidden"
            />
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
            </svg>
            <p className="mt-2 text-sm text-gray-600">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="font-medium text-blue-600 hover:text-blue-500"
              >
                Choose file
              </button>
              {' '}or drag and drop
            </p>
            <p className="mt-1 text-xs text-gray-500">PDF, DOC, PNG, JPG up to 15MB</p>
          </div>

          <div className="flex justify-end space-x-2">
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setNewDocName('');
                setNewDocNumber('');
              }}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        documents.length < maxDocuments && (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="w-full py-2 px-4 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-gray-400 hover:text-gray-800 transition-colors"
          >
            <span className="flex items-center justify-center">
              <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
              </svg>
              Add Document
            </span>
          </button>
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
