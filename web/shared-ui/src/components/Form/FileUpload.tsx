/**
 * FileUpload Component
 * Drag and drop file upload with preview
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { CircleCheck, CloudUpload, File as FileIcon, FileText, Image, X } from 'lucide-react';

export interface UploadedFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  progress: number;
  status: 'pending' | 'uploading' | 'success' | 'error';
  error?: string;
  preview?: string;
}

export interface FileUploadProps {
  value?: UploadedFile[];
  onChange?: (files: UploadedFile[]) => void;
  onUpload?: (file: File) => Promise<void>;
  /**
   * SEC-007: The `accept` attribute is client-side only and is trivially bypassed.
   * It is provided for UX convenience only — do NOT rely on it for security.
   * Always validate file types server-side. The component performs a basic MIME type
   * check against this list as an additional hint, but it cannot be trusted as a
   * security boundary.
   */
  accept?: string;
  maxSize?: number; // in bytes
  maxFiles?: number;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  error?: string;
  helperText?: string;
  required?: boolean;
  showPreview?: boolean;
  className?: string;
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// SEC-012: Use crypto.randomUUID() for unpredictable file IDs
const generateId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substr(2, 9);
};

export const FileUpload: React.FC<FileUploadProps> = ({
  value = [],
  onChange,
  onUpload,
  accept,
  maxSize = 10 * 1024 * 1024, // 10MB default
  maxFiles = 5,
  multiple = true,
  disabled = false,
  label,
  error,
  helperText,
  required = false,
  showPreview = true,
  className = '',
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // BUG-007: Revoke all object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      value.forEach((f) => {
        if (f.preview) URL.revokeObjectURL(f.preview);
      });
    };
  }, []);

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const newFiles: UploadedFile[] = [];

      for (let i = 0; i < fileList.length; i++) {
        if (value.length + newFiles.length >= maxFiles) break;

        const file = fileList[i];

        // Validate size
        if (file.size > maxSize) {
          newFiles.push({
            id: generateId(),
            file,
            name: file.name,
            size: file.size,
            type: file.type,
            progress: 0,
            status: 'error',
            error: `File exceeds maximum size of ${formatFileSize(maxSize)}`,
          });
          continue;
        }

        // Create preview for images
        let preview: string | undefined;
        if (showPreview && file.type.startsWith('image/')) {
          preview = URL.createObjectURL(file);
        }

        const uploadedFile: UploadedFile = {
          id: generateId(),
          file,
          name: file.name,
          size: file.size,
          type: file.type,
          progress: 0,
          status: 'pending',
          preview,
        };

        newFiles.push(uploadedFile);

        // Auto-upload if handler provided
        if (onUpload) {
          uploadedFile.status = 'uploading';
          try {
            await onUpload(file);
            uploadedFile.status = 'success';
            uploadedFile.progress = 100;
          } catch (err) {
            uploadedFile.status = 'error';
            uploadedFile.error = err instanceof Error ? err.message : 'Upload failed';
          }
        } else {
          uploadedFile.status = 'success';
          uploadedFile.progress = 100;
        }
      }

      onChange?.([...value, ...newFiles]);
    },
    [value, maxFiles, maxSize, showPreview, onUpload, onChange],
  );

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (disabled) return;
    if (e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFiles(e.target.files);
    }
    // Reset input
    e.target.value = '';
  };

  const handleRemove = (id: string) => {
    const file = value.find((f) => f.id === id);
    if (file?.preview) {
      URL.revokeObjectURL(file.preview);
    }
    onChange?.(value.filter((f) => f.id !== id));
  };

  const getFileIcon = (type: string) => {
    if (type.startsWith('image/')) {
      return <Image className="w-6 h-6 text-primary-500" aria-hidden="true" />;
    }
    if (type.includes('pdf')) {
      return <FileIcon className="w-6 h-6 text-error-500" aria-hidden="true" />;
    }
    return <FileText className="w-6 h-6 text-gray-500 dark:text-gray-400" aria-hidden="true" />;
  };

  return (
    <div className={className}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {label}
          {required && <span className="text-error-500 ml-1">*</span>}
        </label>
      )}

      {/* Drop zone */}
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
        className={`
          relative border-2 border-dashed rounded-lg p-6 text-center cursor-pointer
          transition-colors duration-200
          ${isDragging ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20' : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          ${error ? 'border-error-500' : ''}
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleInputChange}
          disabled={disabled}
          className="hidden"
        />

        <CloudUpload
          className="mx-auto h-12 w-12 text-gray-500 dark:text-gray-400"
          aria-hidden="true"
        />

        <div className="mt-2">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            <span className="font-medium text-primary-600 dark:text-primary-400">
              Click to upload
            </span>{' '}
            or drag and drop
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {accept ? `Accepted: ${accept}` : 'Any file type'} up to {formatFileSize(maxSize)}
          </p>
        </div>
      </div>

      {/* File list */}
      {value.length > 0 && (
        <div className="mt-4 space-y-2">
          {value.map((file) => (
            <div
              key={file.id}
              className={`
                flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border
                ${file.status === 'error' ? 'border-error-200 dark:border-error-800 bg-error-50 dark:bg-error-900/20' : 'border-gray-200 dark:border-gray-700'}
              `}
            >
              {/* Preview or Icon */}
              {file.preview ? (
                <img
                  src={file.preview}
                  alt={file.name}
                  className="w-10 h-10 object-cover rounded"
                />
              ) : (
                getFileIcon(file.type)
              )}

              {/* File info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {file.name}
                </p>
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span>{formatFileSize(file.size)}</span>
                  {file.status === 'uploading' && (
                    <>
                      <span>-</span>
                      <span>{file.progress}%</span>
                    </>
                  )}
                  {file.status === 'error' && (
                    <span className="text-error-600 dark:text-error-400">{file.error}</span>
                  )}
                </div>

                {/* Progress bar */}
                {file.status === 'uploading' && (
                  <div className="mt-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary-500 transition-all duration-300"
                      style={{ width: `${file.progress}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Status icon */}
              {file.status === 'success' && (
                <CircleCheck className="w-5 h-5 text-success-500" aria-hidden="true" />
              )}

              {/* Remove button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(file.id);
                }}
                className="p-1 text-gray-500 dark:text-gray-400 hover:text-error-500 transition-colors"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="mt-1 text-sm text-error-600 dark:text-error-400" role="alert">
          {error}
        </p>
      )}

      {/* Helper text */}
      {!error && helperText && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{helperText}</p>
      )}

      {/* File count */}
      {maxFiles > 1 && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {value.length} of {maxFiles} files
        </p>
      )}
    </div>
  );
};

export default FileUpload;
