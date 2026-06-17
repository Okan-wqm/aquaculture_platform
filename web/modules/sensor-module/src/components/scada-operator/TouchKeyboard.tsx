/**
 * TouchKeyboard — On-screen virtual keyboard for touch/kiosk environments.
 *
 * Features:
 *  - QWERTY layout with number row
 *  - Numeric-only mode (for entering tag values)
 *  - Special keys: Backspace, Enter, Clear, decimal point, +/- toggle
 *  - Absolute-positioned overlay near the focused input
 *  - Compact design for industrial touch screens
 *  - Supports both text and numeric input modes
 *
 * The keyboard visibility is controlled externally via props. Typical
 * usage: mount the keyboard at the operator shell level and show/hide
 * it when an input field receives/loses focus.
 */

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  memo,
} from 'react';
import { X, Delete, CornerDownLeft } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type KeyboardMode = 'text' | 'numeric';

export interface TouchKeyboardProps {
  /** Whether the keyboard is visible. */
  visible: boolean;
  /** Current input mode. */
  mode?: KeyboardMode;
  /** Current value in the input field. */
  value?: string;
  /** Absolute position (top-left corner) of the keyboard overlay. */
  position?: { x: number; y: number };
  /** Anchor element to position keyboard near. Takes priority over position. */
  anchorRect?: DOMRect | null;
  /** Called when the user types a character or presses a special key. */
  onInput?: (value: string) => void;
  /** Called when Enter is pressed. */
  onSubmit?: (value: string) => void;
  /** Called when the keyboard should be dismissed. */
  onClose?: () => void;
  /** Optional title/label shown in the keyboard header. */
  label?: string;
  /** Max width of the keyboard in pixels. Defaults to 380. */
  maxWidth?: number;
}

/* ------------------------------------------------------------------ */
/*  Key definitions                                                     */
/* ------------------------------------------------------------------ */

interface KeyDef {
  /** Display label on the key. */
  label: string;
  /** Value inserted into the buffer (undefined = special key). */
  value?: string;
  /** Special action type. */
  action?: 'backspace' | 'enter' | 'clear' | 'shift' | 'space' | 'toggle-sign' | 'close';
  /** Column span (default 1). */
  span?: number;
  /** Variant styling. */
  variant?: 'default' | 'action' | 'submit' | 'danger';
}

const QWERTY_ROWS: KeyDef[][] = [
  // Number row
  [
    { label: '1', value: '1' },
    { label: '2', value: '2' },
    { label: '3', value: '3' },
    { label: '4', value: '4' },
    { label: '5', value: '5' },
    { label: '6', value: '6' },
    { label: '7', value: '7' },
    { label: '8', value: '8' },
    { label: '9', value: '9' },
    { label: '0', value: '0' },
  ],
  // Row 1
  [
    { label: 'Q', value: 'q' },
    { label: 'W', value: 'w' },
    { label: 'E', value: 'e' },
    { label: 'R', value: 'r' },
    { label: 'T', value: 't' },
    { label: 'Y', value: 'y' },
    { label: 'U', value: 'u' },
    { label: 'I', value: 'i' },
    { label: 'O', value: 'o' },
    { label: 'P', value: 'p' },
  ],
  // Row 2
  [
    { label: 'A', value: 'a' },
    { label: 'S', value: 's' },
    { label: 'D', value: 'd' },
    { label: 'F', value: 'f' },
    { label: 'G', value: 'g' },
    { label: 'H', value: 'h' },
    { label: 'J', value: 'j' },
    { label: 'K', value: 'k' },
    { label: 'L', value: 'l' },
  ],
  // Row 3
  [
    { label: 'Shift', action: 'shift', span: 1, variant: 'action' },
    { label: 'Z', value: 'z' },
    { label: 'X', value: 'x' },
    { label: 'C', value: 'c' },
    { label: 'V', value: 'v' },
    { label: 'B', value: 'b' },
    { label: 'N', value: 'n' },
    { label: 'M', value: 'm' },
    { label: '\u232B', action: 'backspace', span: 1, variant: 'action' },
  ],
  // Row 4
  [
    { label: 'CLR', action: 'clear', variant: 'danger' },
    { label: '.', value: '.' },
    { label: 'Space', action: 'space', span: 5, variant: 'default' },
    { label: '-', value: '-' },
    { label: '\u23CE', action: 'enter', span: 2, variant: 'submit' },
  ],
];

const NUMERIC_ROWS: KeyDef[][] = [
  [
    { label: '7', value: '7' },
    { label: '8', value: '8' },
    { label: '9', value: '9' },
  ],
  [
    { label: '4', value: '4' },
    { label: '5', value: '5' },
    { label: '6', value: '6' },
  ],
  [
    { label: '1', value: '1' },
    { label: '2', value: '2' },
    { label: '3', value: '3' },
  ],
  [
    { label: '+/-', action: 'toggle-sign', variant: 'action' },
    { label: '0', value: '0' },
    { label: '.', value: '.' },
  ],
  [
    { label: 'CLR', action: 'clear', variant: 'danger' },
    { label: '\u232B', action: 'backspace', variant: 'action' },
    { label: '\u23CE', action: 'enter', variant: 'submit' },
  ],
];

/* ------------------------------------------------------------------ */
/*  Key button                                                          */
/* ------------------------------------------------------------------ */

const VARIANT_CLASSES: Record<string, string> = {
  default:
    'bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-gray-100 border-gray-600',
  action:
    'bg-gray-600 hover:bg-gray-500 active:bg-gray-400 text-gray-200 border-gray-500',
  submit:
    'bg-blue-700 hover:bg-blue-600 active:bg-blue-500 text-white border-blue-600',
  danger:
    'bg-red-800/60 hover:bg-red-700/60 active:bg-red-600/60 text-red-200 border-red-700/50',
};

interface KeyButtonProps {
  keyDef: KeyDef;
  shifted: boolean;
  onPress: (keyDef: KeyDef) => void;
}

const KeyButton = memo<KeyButtonProps>(({ keyDef, shifted, onPress }) => {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onPress(keyDef);
    },
    [keyDef, onPress],
  );

  const displayLabel =
    keyDef.value && shifted ? keyDef.label.toUpperCase() : keyDef.label;

  const variantClass = VARIANT_CLASSES[keyDef.variant ?? 'default'];

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`
        flex items-center justify-center rounded border text-sm font-medium
        transition-colors select-none
        focus:outline-hidden focus-visible:ring-1 focus-visible:ring-blue-400
        ${variantClass}
      `}
      style={{
        gridColumn: keyDef.span ? `span ${keyDef.span}` : undefined,
        minHeight: 44,
        touchAction: 'manipulation',
      }}
      aria-label={keyDef.action ?? keyDef.value ?? keyDef.label}
    >
      {keyDef.action === 'backspace' ? (
        <Delete size={16} aria-hidden="true" />
      ) : keyDef.action === 'enter' ? (
        <CornerDownLeft size={16} aria-hidden="true" />
      ) : (
        displayLabel
      )}
    </button>
  );
});
KeyButton.displayName = 'KeyButton';

/* ------------------------------------------------------------------ */
/*  TouchKeyboard                                                       */
/* ------------------------------------------------------------------ */

export const TouchKeyboard = memo<TouchKeyboardProps>(
  ({
    visible,
    mode = 'text',
    value: externalValue,
    position,
    anchorRect,
    onInput,
    onSubmit,
    onClose,
    label,
    maxWidth = 380,
  }) => {
    const [internalValue, setInternalValue] = useState(externalValue ?? '');
    const [shifted, setShifted] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Sync with external value
    useEffect(() => {
      if (externalValue !== undefined) {
        setInternalValue(externalValue);
      }
    }, [externalValue]);

    // Compute position
    const computedPosition = useMemo(() => {
      if (anchorRect) {
        // Position below the anchor, clamped to viewport
        const x = Math.max(8, Math.min(anchorRect.left, window.innerWidth - maxWidth - 8));
        const y = anchorRect.bottom + 8;
        // If keyboard would go below viewport, position above
        const maxKbHeight = mode === 'numeric' ? 300 : 320;
        const adjustedY =
          y + maxKbHeight > window.innerHeight
            ? Math.max(8, anchorRect.top - maxKbHeight - 8)
            : y;
        return { x, y: adjustedY };
      }
      return position ?? { x: 0, y: 0 };
    }, [anchorRect, position, maxWidth, mode]);

    // Update buffer and notify parent
    const updateValue = useCallback(
      (newValue: string) => {
        setInternalValue(newValue);
        onInput?.(newValue);
      },
      [onInput],
    );

    // Key press handler
    const handleKeyPress = useCallback(
      (keyDef: KeyDef) => {
        if (keyDef.action) {
          switch (keyDef.action) {
            case 'backspace':
              updateValue(internalValue.slice(0, -1));
              break;
            case 'clear':
              updateValue('');
              break;
            case 'enter':
              onSubmit?.(internalValue);
              break;
            case 'shift':
              setShifted((prev) => !prev);
              break;
            case 'space':
              updateValue(internalValue + ' ');
              break;
            case 'toggle-sign': {
              if (internalValue.startsWith('-')) {
                updateValue(internalValue.slice(1));
              } else if (internalValue.length > 0) {
                updateValue('-' + internalValue);
              }
              break;
            }
            case 'close':
              onClose?.();
              break;
          }
        } else if (keyDef.value !== undefined) {
          // Decimal point guard: only one decimal allowed in numeric mode
          if (keyDef.value === '.' && mode === 'numeric' && internalValue.includes('.')) {
            return;
          }
          const char = shifted ? keyDef.value.toUpperCase() : keyDef.value;
          updateValue(internalValue + char);
          // Auto-unshift after typing a character
          if (shifted) setShifted(false);
        }
      },
      [internalValue, shifted, mode, updateValue, onSubmit, onClose],
    );

    const rows = mode === 'numeric' ? NUMERIC_ROWS : QWERTY_ROWS;
    const gridCols = mode === 'numeric' ? 3 : 10;
    const kbWidth = mode === 'numeric' ? Math.min(maxWidth, 220) : maxWidth;

    if (!visible) return null;

    return (
      <div
        ref={containerRef}
        className="fixed z-50"
        style={{
          left: computedPosition.x,
          top: computedPosition.y,
          width: kbWidth,
          touchAction: 'none',
        }}
        role="dialog"
        aria-label={label ? `Keyboard: ${label}` : 'Virtual keyboard'}
        aria-modal="false"
      >
        <div className="bg-gray-850 border border-gray-600 rounded-lg shadow-2xl overflow-hidden"
          style={{ backgroundColor: '#1a1d23' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
            <div className="flex items-center gap-2 min-w-0">
              {label && (
                <span className="text-[10px] text-gray-400 uppercase tracking-wider truncate">
                  {label}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Live value display */}
              <div
                className="bg-gray-900 border border-gray-600 rounded px-2 py-0.5 text-xs text-gray-100 font-mono min-w-[80px] text-right truncate"
                aria-live="polite"
              >
                {internalValue || '\u00A0'}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-100 transition-colors focus:outline-hidden focus-visible:ring-1 focus-visible:ring-blue-400"
                aria-label="Close keyboard"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Key grid */}
          <div className="p-2 flex flex-col gap-1.5">
            {rows.map((row, rowIndex) => (
              <div
                key={rowIndex}
                className="grid gap-1"
                style={{
                  gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
                }}
              >
                {row.map((keyDef, keyIndex) => (
                  <KeyButton
                    key={`${rowIndex}-${keyIndex}`}
                    keyDef={keyDef}
                    shifted={shifted}
                    onPress={handleKeyPress}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Mode indicator */}
          <div className="flex items-center justify-between px-3 py-1 border-t border-gray-700">
            <span className="text-[9px] text-gray-500 uppercase tracking-wider">
              {mode === 'numeric' ? 'Numeric' : 'Text'}
            </span>
            {shifted && mode === 'text' && (
              <span className="text-[9px] text-blue-400 uppercase tracking-wider">
                SHIFT
              </span>
            )}
          </div>
        </div>
      </div>
    );
  },
);
TouchKeyboard.displayName = 'TouchKeyboard';
