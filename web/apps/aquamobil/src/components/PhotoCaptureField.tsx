/**
 * PhotoCaptureField — attach evidence photos to a regulatory incident record.
 *
 * WHY: The escape / welfare / lice pages let a field worker photograph what they
 * are reporting (net damage, gill lesions, a lice sample). This field captures a
 * rear-camera photo, uploads it immediately (upload-at-capture) via
 * {@link useIncidentMediaUpload}, and surfaces the resulting MinIO storageKeys to
 * the page through `onChange` so they ride the record's `mediaKeys`.
 *
 * Controlled contract: `value` is the authoritative storageKey list (page state);
 * the component keeps a parallel preview (object URL) per key internally and
 * reconciles to `value` — a key the page drops (removal or post-submit reset)
 * prunes its preview and revokes the URL. New previews only ever come from a
 * capture here.
 *
 * OFFLINE: capture requires connectivity (the presign + PUT cannot happen
 * offline, and this change does NOT build the offline blob-replay lane). When
 * offline the control is disabled with an honest hint; the record itself still
 * submits without photos through the offline queue.
 *
 * Ergonomics (MOB-MEDIUM-009): every tap target clears the 44px floor via
 * IconButton / min-h-touch, and no label uses sub-12px text.
 */
import { clsx } from 'clsx';
import { Camera, ImageOff, Loader2, X } from 'lucide-react';
import {
  type ChangeEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { IconButton } from '@/components/ui/IconButton';
import { useIncidentMediaUpload, type IncidentMediaType } from '@/hooks/useIncidentMediaUpload';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';

/** Field-capture cap — plenty for evidence without ballooning a single record. */
const MAX_INCIDENT_PHOTOS = 10;

interface PhotoItem {
  /** MinIO storageKey returned by the upload. */
  key: string;
  /** Local object URL for the thumbnail preview. */
  url: string;
}

interface PhotoCaptureFieldProps {
  /** Which incident category these photos belong to. */
  incidentType: IncidentMediaType;
  /** Controlled list of uploaded storageKeys (page state). */
  value: string[];
  /** Called with the next storageKey list on add/remove. */
  onChange: (keys: string[]) => void;
}

export function PhotoCaptureField({
  incidentType,
  value,
  onChange,
}: PhotoCaptureFieldProps): ReactElement {
  const isOnline = useNetworkStatus();
  const { uploadPhoto, isUploading } = useIncidentMediaUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Keep a live mirror of items so the unmount cleanup revokes the CURRENT set
  // without re-subscribing the cleanup effect on every change.
  const itemsRef = useRef<PhotoItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Reconcile previews to the controlled `value`: prune (and revoke) any preview
  // whose storageKey the page has dropped. New previews are only ever appended
  // by a capture here — they can't be reconstructed from a key alone.
  useEffect(() => {
    setItems((prev) => {
      const kept = prev.filter((it) => value.includes(it.key));
      if (kept.length === prev.length) return prev;
      for (const gone of prev) {
        if (!value.includes(gone.key)) URL.revokeObjectURL(gone.url);
      }
      return kept;
    });
  }, [value]);

  // Revoke any outstanding object URLs when the field unmounts.
  useEffect(() => {
    return (): void => {
      for (const it of itemsRef.current) URL.revokeObjectURL(it.url);
    };
  }, []);

  const atCapacity = value.length >= MAX_INCIDENT_PHOTOS;
  const captureDisabled = !isOnline || isUploading || atCapacity;

  const handleFile = useCallback(
    async (file: File): Promise<void> => {
      setError(null);
      try {
        const key = await uploadPhoto(file, incidentType);
        const url = URL.createObjectURL(file);
        setItems((prev) => [...prev, { key, url }]);
        onChange([...value, key]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      }
    },
    [uploadPhoto, incidentType, onChange, value],
  );

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>): void => {
      const file = e.target.files?.[0];
      // Reset so re-picking the same file fires change again.
      e.target.value = '';
      // handleFile owns its errors (never rejects) — fire and forget.
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const handleCaptureClick = useCallback((): void => {
    inputRef.current?.click();
  }, []);

  const handleRemove = useCallback(
    (key: string): void => {
      // Drop the key from the controlled list; the reconcile effect prunes the
      // preview and revokes its URL.
      onChange(value.filter((k) => k !== key));
    },
    [onChange, value],
  );

  return (
    <div className="px-4 mt-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
          Photos (Optional)
        </h3>
        <span className="text-xs text-gray-400 tabular-nums">
          {value.length}/{MAX_INCIDENT_PHOTOS}
        </span>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800">
        <div className="grid grid-cols-3 gap-3">
          {items.map((it) => (
            <div
              key={it.key}
              className="relative aspect-square rounded-xl overflow-hidden border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800"
            >
              <img
                src={it.url}
                alt="Incident evidence"
                className="w-full h-full object-cover"
              />
              <IconButton
                aria-label="Remove photo"
                onClick={() => handleRemove(it.key)}
                className="absolute top-1 right-1 bg-black/60 text-white shadow-md hover:bg-black/75"
              >
                <X size={18} />
              </IconButton>
            </div>
          ))}

          {!atCapacity && (
            <button
              type="button"
              onClick={handleCaptureClick}
              disabled={captureDisabled}
              aria-label="Add photo"
              className={clsx(
                'aspect-square min-h-touch min-w-touch rounded-xl border-2 border-dashed',
                'flex flex-col items-center justify-center gap-1 touch-feedback transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400',
                'active:scale-95',
              )}
            >
              {isUploading ? (
                <Loader2 size={24} className="animate-spin" />
              ) : isOnline ? (
                <Camera size={24} />
              ) : (
                <ImageOff size={24} />
              )}
              <span className="text-xs font-semibold">
                {isUploading ? 'Uploading' : 'Add'}
              </span>
            </button>
          )}
        </div>

        {/* Offline honesty: capture needs connectivity for the presign + PUT. */}
        {!isOnline && (
          <p className="text-xs text-amber-600 dark:text-amber-400 font-medium mt-3">
            Connect to add photos — the record still submits without them.
          </p>
        )}

        {error && (
          <p className="text-xs text-red-500 dark:text-red-400 font-medium mt-3">{error}</p>
        )}

        {/* Hidden rear-camera capture input (reuses the AttachmentPicker approach). */}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={handleInputChange}
          className="hidden"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
