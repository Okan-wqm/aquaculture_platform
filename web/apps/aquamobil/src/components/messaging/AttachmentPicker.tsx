import { MESSAGING_MEDIA_MIME_ALLOWLIST } from '@aquaculture/shared-contracts';
import { clsx } from 'clsx';
import { Camera, Image as ImageIcon, FileText, X } from 'lucide-react';
import {
  useRef,
  useCallback,
  useEffect,
  useState,
  useMemo,
  type ReactElement,
  type RefObject,
} from 'react';

import { IconButton } from '@/components/ui';

// MSG-LOW-051: the picker validates against the SAME shared MIME allowlist SSoT
// the upload hook and the server enforce — no third hand-maintained list, so
// drift is structurally impossible. The check is advisory UX (fail fast with a
// clear message); the server remains the enforcing boundary.
const ALLOWED_MIME_TYPES = new Set<string>(MESSAGING_MEDIA_MIME_ALLOWLIST);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AttachmentPickerProps {
  /** Whether the picker sheet is open. */
  isOpen: boolean;
  /** Callback to close the picker. */
  onClose: () => void;
  /** Callback when a file is selected. */
  onFileSelect: (file: File) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_SIZE_LIMIT_MB = 25;

/**
 * WHY: Three distinct input modes cover all field-worker attachment needs.
 * - Camera: quick photo of tank/equipment (capture="environment" = rear camera)
 * - Gallery: existing photos/videos from device
 * - File: documents like lab reports, PDFs, spreadsheets
 *
 * The three tiles take three v4 decorative hues so they stay distinguishable at
 * a glance; none is an alarm colour, because none of these is a warning.
 */
const ATTACHMENT_OPTIONS = [
  {
    id: 'camera',
    label: 'Camera',
    icon: Camera,
    accept: 'image/*',
    capture: 'environment' as const,
    color: 'bg-acc-dim text-acc',
  },
  {
    id: 'gallery',
    label: 'Gallery',
    icon: ImageIcon,
    accept: 'image/*,video/*',
    capture: undefined,
    color: 'bg-type-water-dim text-type-water',
  },
  {
    id: 'file',
    label: 'File',
    icon: FileText,
    accept: '.pdf,.doc,.docx,.xls,.xlsx',
    capture: undefined,
    color: 'bg-type-transfer-dim text-type-transfer',
  },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * AttachmentPicker -- bottom sheet overlay for file selection.
 *
 * WHY slide-up animation: Bottom sheets are the standard mobile pattern
 * for secondary actions. The slide-up motion follows the user's mental
 * model of "pulling up options from below."
 *
 * WHY backdrop tap to close: Prevents accidental attachment selection
 * and follows platform conventions (iOS action sheet, Android bottom sheet).
 */
export function AttachmentPicker({
  isOpen,
  onClose,
  onFileSelect,
}: AttachmentPickerProps): ReactElement | null {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // WHY useMemo: the ref-by-id lookup map must be referentially stable so it can
  // be a correct dependency of handleOptionPress. The underlying ref objects are
  // themselves stable across renders, so the map only needs to be built once.
  const inputRefs = useMemo<Record<string, RefObject<HTMLInputElement | null>>>(
    () => ({
      camera: cameraInputRef,
      gallery: galleryInputRef,
      file: fileInputRef,
    }),
    [],
  );

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const handleOptionPress = useCallback(
    (optionId: string): void => {
      const ref = inputRefs[optionId];
      ref?.current?.click();
    },
    [inputRefs],
  );

  const [pickerError, setPickerError] = useState<string | null>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        // MSG-LOW-051: pre-flight MIME validation against the shared allowlist
        // SSoT BEFORE onFileSelect, so an unsupported type (e.g. svg) is rejected
        // at pick time with a specific message instead of failing late and
        // generically deep inside uploadMedia. onFileSelect is NOT called for a
        // disallowed type, so no orphan upload is even attempted.
        if (!ALLOWED_MIME_TYPES.has(file.type)) {
          setPickerError(
            file.type
              ? `File type "${file.type}" is not supported`
              : 'This file type is not supported',
          );
          e.target.value = '';
          return;
        }
        // Client-side file size validation before passing to onFileSelect
        const maxBytes = FILE_SIZE_LIMIT_MB * 1024 * 1024;
        if (file.size > maxBytes) {
          setPickerError(
            `File exceeds ${FILE_SIZE_LIMIT_MB}MB limit (${Math.round(file.size / 1024 / 1024)}MB)`,
          );
          e.target.value = '';
          return;
        }
        setPickerError(null);
        onFileSelect(file);
        onClose();
      }
      // Reset input so the same file can be re-selected
      e.target.value = '';
    },
    [onFileSelect, onClose],
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 animate-am-fade"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet.
          WHY the local @keyframes are gone: the v4 motion layer already owns
          these two entrances (`am-up` springs from the dock, `am-fade` for the
          scrim), and unlike the inline <style> block they replace, they stop
          under prefers-reduced-motion via the global rule in main.css. */}
      <div
        className={clsx(
          'relative w-full max-w-lg bg-surface-1 border border-line-strong border-b-0',
          'rounded-t-3xl shadow-token pb-safe animate-am-up',
        )}
      >
        {/* Handle bar */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 bg-line-strong rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-3">
          <h3 className="text-title font-bold text-ink-1">Share</h3>
          <IconButton
            onClick={onClose}
            className="hover:bg-surface-2 transition-colors"
            aria-label="Close"
          >
            <X size={20} className="text-ink-2" />
          </IconButton>
        </div>

        {/* Option grid */}
        <div className="grid grid-cols-3 gap-4 px-8 pb-4">
          {ATTACHMENT_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                onClick={() => handleOptionPress(opt.id)}
                className="flex flex-col items-center gap-2 py-3 touch-feedback transition-transform active:scale-95"
              >
                <div
                  className={clsx(
                    'w-16 h-16 rounded-2xl flex items-center justify-center',
                    opt.color,
                  )}
                >
                  <Icon size={28} />
                </div>
                <span className="text-meta font-semibold text-ink-2">{opt.label}</span>
              </button>
            );
          })}
        </div>

        {/* MSG-LOW-051: unsupported-type / oversize error surfaced in the same
            slot, at pick time. text-meta is 12px, the sunlight floor — it
            replaces an 11px arbitrary size, and a rejection message is the last
            thing that should be hard to read. */}
        {pickerError && (
          <p className="text-center text-meta text-crit font-medium pb-2 px-4">{pickerError}</p>
        )}

        {/* File size info */}
        <p className="text-center text-meta text-ink-3 pb-4">
          Max file size: {FILE_SIZE_LIMIT_MB}MB
        </p>

        {/* Hidden file inputs */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
        />
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*,video/*"
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.xls,.xlsx"
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
