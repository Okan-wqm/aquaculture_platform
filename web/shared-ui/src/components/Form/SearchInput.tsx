/**
 * Search Input Component
 * Specialized input for search functionality with debounce
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';

export interface SearchInputProps {
  value?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  onSearch?: (value: string) => void;
  debounceMs?: number;
  size?: 'sm' | 'md' | 'lg';
  showClearButton?: boolean;
  loading?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

export const SearchInput: React.FC<SearchInputProps> = ({
  value: controlledValue,
  placeholder = 'Search...',
  onChange,
  onSearch,
  debounceMs = 300,
  size = 'md',
  showClearButton = true,
  loading = false,
  disabled = false,
  autoFocus = false,
  className = '',
}) => {
  const [internalValue, setInternalValue] = useState(controlledValue || '');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync with controlled value
  useEffect(() => {
    if (controlledValue !== undefined) {
      setInternalValue(controlledValue);
    }
  }, [controlledValue]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setInternalValue(newValue);
      onChange?.(newValue);

      // Debounced search
      if (onSearch) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }
        debounceRef.current = setTimeout(() => {
          onSearch(newValue);
        }, debounceMs);
      }
    },
    [onChange, onSearch, debounceMs]
  );

  const handleClear = useCallback(() => {
    setInternalValue('');
    onChange?.('');
    onSearch?.('');
    inputRef.current?.focus();
  }, [onChange, onSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && onSearch) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }
        onSearch(internalValue);
      }
      if (e.key === 'Escape') {
        handleClear();
      }
    },
    [onSearch, internalValue, handleClear]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm pl-9',
    md: 'px-4 py-2 text-sm pl-10',
    lg: 'px-4 py-2.5 text-base pl-11',
  };

  const iconSizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-5 h-5',
  };

  return (
    <div className={`relative ${className}`}>
      {/* Search Icon */}
      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
        {loading ? (
          <svg
            className={`${iconSizeClasses[size]} text-gray-400 animate-spin`}
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : (
          <svg
            className={`${iconSizeClasses[size]} text-gray-400`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        )}
      </div>

      {/* Input */}
      <input
        ref={inputRef}
        type="text"
        value={internalValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        className={`
          block w-full rounded-lg border border-gray-300
          bg-white text-gray-900
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500
          disabled:bg-gray-100 disabled:cursor-not-allowed
          transition-colors duration-200
          ${sizeClasses[size]}
          ${showClearButton && internalValue ? 'pr-10' : ''}
        `}
      />

      {/* Clear Button */}
      {showClearButton && internalValue && !disabled && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
        >
          <svg className={iconSizeClasses[size]} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
};

export default SearchInput;
