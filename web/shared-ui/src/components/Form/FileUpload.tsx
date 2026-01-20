/**
 * FileUpload Component
 * Drag and drop file upload with preview
 */

import React, { useState, useRef, useCallback } from 'react';

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

const generateId = () => Math.random().toString(36).substr(2, 9);

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
    [value, maxFiles, maxSize, showPreview, onUpload, onChange]
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
      return (
        <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      );
    }
    if (type.includes('pdf')) {
      return (
        <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      );
    }
    return (
      <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    );
  };

  return (
    <div className={className}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
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
          ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          ${error ? 'border-red-500' : ''}
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

        <svg
          className="mx-auto h-12 w-12 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>

        <div className="mt-2">
          <p className="text-sm text-gray-600">
            <span className="font-medium text-blue-600">Click to upload</span> or drag and drop
          </p>
          <p className="text-xs text-gray-500 mt-1">
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
                flex items-center gap-3 p-3 bg-gray-50 rounded-lg border
                ${file.status === 'error' ? 'border-red-200 bg-red-50' : 'border-gray-200'}
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
                <p className="text-sm font-medium text-gray-900 truncate">{file.name}</p>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <span>{formatFileSize(file.size)}</span>
                  {file.status === 'uploading' && (
                    <>
                      <span>-</span>
                      <span>{file.progress}%</span>
                    </>
                  )}
                  {file.status === 'error' && (
                    <span className="text-red-600">{file.error}</span>
                  )}
                </div>

                {/* Progress bar */}
                {file.status === 'uploading' && (
                  <div className="mt-1 h-1 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all duration-300"
                      style={{ width: `${file.progress}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Status icon */}
              {file.status === 'success' && (
                <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              )}

              {/* Remove button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(file.id);
                }}
                className="p-1 text-gray-400 hover:text-red-500 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="mt-1 text-sm text-red-600" role="alert">{error}</p>
      )}

      {/* Helper text */}
      {!error && helperText && (
        <p className="mt-1 text-sm text-gray-500">{helperText}</p>
      )}

      {/* File count */}
      {maxFiles > 1 && (
        <p className="mt-1 text-xs text-gray-400">
          {value.length} of {maxFiles} files
        </p>
      )}
    </div>
  );
};

export default FileUpload;
