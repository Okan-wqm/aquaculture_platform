/**
 * DropdownSelectRenderer - Dropdown selection control for discrete value input.
 * Presents a list of predefined options; selecting an option writes the
 * corresponding value to the bound tag via onCommand.
 *
 * Architecture: Custom popover (not native <select>) for consistent
 * styling across browsers. ARIA listbox pattern for accessibility.
 * Keyboard navigation: Arrow keys, Enter to select, Escape to close.
 *
 * The popover renders inside the widget bounds using absolute positioning.
 * Focus management ensures keyboard-only users can navigate the list.
 */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DropdownOption {
  label: string;
  value: string | number;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const DropdownSelectRenderer: React.FC<WidgetRendererProps> = ({
  config,
  value,
  width,
  height,
  isEditing,
  onCommand,
}) => {
  /* ---- Config ---- */
  const placeholder = (config.placeholder as string) ?? 'Select...';
  const showLabel = (config.showLabel as boolean) ?? true;
  const label = (config.label as string) ?? 'Selection';
  const configFontSize = (config.fontSize as number) ?? 12;
  const borderColor = (config.borderColor as string) ?? '#d1d5db';
  const backgroundColor = (config.backgroundColor as string) ?? '#ffffff';

  const options: DropdownOption[] = (() => {
    const raw = config.options as DropdownOption[] | undefined;
    if (raw && raw.length > 0) return raw;
    // Default demo options for editor preview
    return [
      { label: 'Auto', value: 0 },
      { label: 'Manual', value: 1 },
      { label: 'Off', value: 2 },
    ];
  })();

  /* ---- State ---- */
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  /* ---- Resolve current selection ---- */
  const currentValue = value ?? '';
  const selectedOption = options.find(
    (opt) => String(opt.value) === String(currentValue),
  );
  const displayText = selectedOption?.label ?? placeholder;
  const hasSelection = selectedOption !== undefined;

  /* ---- Handlers ---- */
  const toggleOpen = useCallback(() => {
    if (isEditing) return;
    setIsOpen((prev) => !prev);
    setHighlightIndex(-1);
  }, [isEditing]);

  const selectOption = useCallback(
    (opt: DropdownOption) => {
      if (onCommand) {
        onCommand('setValue', opt.value);
      }
      setIsOpen(false);
      setHighlightIndex(-1);
    },
    [onCommand],
  );

  /* ---- Keyboard navigation (ARIA listbox pattern) ---- */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isEditing) return;

      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (!isOpen) {
            setIsOpen(true);
            setHighlightIndex(0);
          } else if (highlightIndex >= 0 && highlightIndex < options.length) {
            selectOption(options[highlightIndex]);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) {
            setIsOpen(true);
            setHighlightIndex(0);
          } else {
            setHighlightIndex((prev) => Math.min(prev + 1, options.length - 1));
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (isOpen) {
            setHighlightIndex((prev) => Math.max(prev - 1, 0));
          }
          break;
        case 'Escape':
          e.preventDefault();
          setIsOpen(false);
          setHighlightIndex(-1);
          break;
        case 'Home':
          if (isOpen) {
            e.preventDefault();
            setHighlightIndex(0);
          }
          break;
        case 'End':
          if (isOpen) {
            e.preventDefault();
            setHighlightIndex(options.length - 1);
          }
          break;
      }
    },
    [isEditing, isOpen, highlightIndex, options, selectOption],
  );

  /* ---- Scroll highlighted item into view ---- */
  useEffect(() => {
    if (isOpen && highlightIndex >= 0 && listRef.current) {
      const items = listRef.current.children;
      const item = items[highlightIndex] as HTMLElement | undefined;
      if (item && typeof item.scrollIntoView === 'function') {
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [isOpen, highlightIndex]);

  /* ---- Close on outside click ---- */
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setHighlightIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  /* ---- Layout ---- */
  const PAD = 8;
  const LABEL_H = showLabel ? 18 : 0;
  const BUTTON_H = Math.max(28, height - PAD * 2 - LABEL_H - 4);
  const maxListH = Math.min(options.length * 30, 150);

  /* ---- Chevron SVG icon ---- */
  const chevron = (
    <svg
      width={12}
      height={12}
      viewBox="0 0 12 12"
      fill="none"
      style={{
        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 150ms ease',
        flexShrink: 0,
      }}
    >
      <path
        d="M3 4.5L6 7.5L9 4.5"
        stroke="#6b7280"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );

  return (
    <div
      ref={containerRef}
      style={{
        width,
        height,
        padding: PAD,
        boxSizing: 'border-box',
        position: 'relative',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* Label */}
      {showLabel && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: '#6b7280',
            marginBottom: 4,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </div>
      )}

      {/* Trigger button */}
      <button
        type="button"
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={label}
        onClick={toggleOpen}
        onKeyDown={handleKeyDown}
        style={{
          width: '100%',
          height: BUTTON_H,
          padding: '0 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 4,
          fontSize: configFontSize,
          fontFamily: 'inherit',
          color: hasSelection ? '#111827' : '#9ca3af',
          background: backgroundColor,
          border: `1px solid ${isOpen ? '#06b6d4' : borderColor}`,
          borderRadius: 6,
          cursor: isEditing ? 'default' : 'pointer',
          outline: 'none',
          boxShadow: isOpen ? '0 0 0 2px rgba(6, 182, 212, 0.2)' : 'none',
          transition: 'border-color 150ms, box-shadow 150ms',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            flex: 1,
          }}
        >
          {displayText}
        </span>
        {chevron}
      </button>

      {/* Dropdown popover */}
      {isOpen && !isEditing && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={label}
          style={{
            position: 'absolute',
            left: PAD,
            right: PAD,
            top: PAD + LABEL_H + BUTTON_H + 2,
            maxHeight: maxListH,
            overflowY: 'auto',
            margin: 0,
            padding: 4,
            listStyle: 'none',
            background: '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            boxShadow:
              '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)',
            zIndex: 50,
          }}
        >
          {options.map((opt, i) => {
            const isHighlighted = i === highlightIndex;
            const isSelected = String(opt.value) === String(currentValue);
            return (
              <li
                key={String(opt.value) + i}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setHighlightIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // Prevent blur before selection
                  selectOption(opt);
                }}
                style={{
                  padding: '6px 8px',
                  fontSize: configFontSize - 1,
                  color: isSelected ? '#06b6d4' : '#374151',
                  fontWeight: isSelected ? 600 : 400,
                  background: isHighlighted ? '#f0fdfa' : 'transparent',
                  borderRadius: 4,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'background 100ms',
                }}
              >
                {/* Selection indicator */}
                {isSelected && (
                  <svg width={12} height={12} viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2.5 6L5 8.5L9.5 3.5"
                      stroke="#06b6d4"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                <span
                  style={{
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    marginLeft: isSelected ? 0 : 18,
                  }}
                >
                  {opt.label}
                </span>
              </li>
            );
          })}
          {options.length === 0 && (
            <li
              style={{
                padding: '8px',
                fontSize: 11,
                color: '#9ca3af',
                textAlign: 'center',
              }}
            >
              No options configured
            </li>
          )}
        </ul>
      )}
    </div>
  );
};

DropdownSelectRenderer.displayName = 'DropdownSelectRenderer';
export default memo(DropdownSelectRenderer);
