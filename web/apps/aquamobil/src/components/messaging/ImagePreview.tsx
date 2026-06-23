import { clsx } from 'clsx';
import { X, Send } from 'lucide-react';
import { useState, useEffect, type ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImagePreviewProps {
  /** File object for the selected image. */
  file: File;
  /** Object URL or data URL for the preview. */
  previewUrl: string;
  /** Callback when user confirms sending the image. */
  onSend: (file: File, caption: string) => void;
  /** Callback when user cancels. */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * WHY: Human-readable file size helps field workers understand what they
 * are about to send over potentially slow cellular connections.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const COMPRESSION_THRESHOLD = 2 * 1024 * 1024; // 2 MB

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ImagePreview -- full-screen preview of an image before sending.
 *
 * WHY full-screen overlay: Field workers need to verify the photo is
 * correct (right tank, readable label, proper focus) before burning
 * mobile data on an upload. The large preview prevents sending
 * blurry/wrong photos.
 *
 * WHY compression indicator: On metered or satellite connections,
 * knowing the image will be compressed reassures the user that the
 * upload won't be excessively slow.
 */
export function ImagePreview({ file, previewUrl, onSend, onCancel }: ImagePreviewProps): ReactElement {
  const [caption, setCaption] = useState('');

  // Dismiss on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const willCompress = file.size > COMPRESSION_THRESHOLD;

  const handleSend = (): void => {
    onSend(file, caption.trim());
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Top bar: cancel + file info */}
      <div className="flex items-center justify-between px-4 pt-safe-top py-3 bg-black/80">
        <button
          onClick={onCancel}
          className="min-w-[48px] min-h-[48px] flex items-center justify-center rounded-full hover:bg-white/10 touch-feedback transition-colors"
          aria-label="Cancel"
        >
          <X size={24} className="text-white" />
        </button>
        <div className="text-right">
          <p className="text-sm font-medium text-white truncate max-w-[200px]">{file.name}</p>
          <p className="text-xs text-white/60">{formatFileSize(file.size)}</p>
        </div>
      </div>

      {/* Image preview */}
      <div className="flex-1 flex items-center justify-center px-4 overflow-hidden">
        <img
          src={previewUrl}
          alt="Preview"
          className="max-w-full max-h-full object-contain rounded-xl"
        />
      </div>

      {/* Compression indicator */}
      {willCompress && (
        <div className="flex justify-center py-2">
          <span className="text-xs text-amber-400 font-medium bg-amber-500/10 px-3 py-1 rounded-full">
            Image will be compressed before sending
          </span>
        </div>
      )}

      {/* Bottom bar: caption input + send */}
      <div className="bg-black/80 pb-safe px-4 py-3">
        <div className="flex items-end gap-2">
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Add a caption..."
            maxLength={500}
            className={clsx(
              'flex-1 bg-white/10 text-white placeholder-white/40 text-sm rounded-2xl px-4 py-3',
              'border border-white/10 focus:outline-none focus:ring-2 focus:ring-ocean-500/40 focus:border-ocean-500 transition-all',
            )}
          />
          <button
            onClick={handleSend}
            className="min-w-[48px] min-h-[48px] flex items-center justify-center rounded-full bg-ocean-600 hover:bg-ocean-700 shadow-glow-ocean touch-feedback transition-all"
            aria-label="Send image"
          >
            <Send size={20} className="text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}
