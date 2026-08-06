import { clsx } from 'clsx';
import { X, Send } from 'lucide-react';
import { useState, useEffect, type ReactElement } from 'react';

import { IconButton } from '@/components/ui';

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
export function ImagePreview({
  file,
  previewUrl,
  onSend,
  onCancel,
}: ImagePreviewProps): ReactElement {
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

  // WHY the chrome here stays black-and-white instead of taking the surface and
  // ink tokens: this is a photo viewer, and a photo is judged against a neutral
  // black ground in every theme — the ground is deliberately NOT theme-varying.
  // The ink tokens are calibrated against the theme's OWN surfaces, so the muted
  // ink on this fixed black would be unreadable in the day theme. The brand
  // accent still comes from the token, because a filled button carries its own
  // contrast (see the send button below).
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Top bar: cancel + file info */}
      <div className="flex items-center justify-between px-4 pt-safe-top py-3 bg-black/80">
        <IconButton
          size="lg"
          onClick={onCancel}
          className="hover:bg-white/10 transition-colors"
          aria-label="Cancel"
        >
          <X size={24} className="text-white" />
        </IconButton>
        <div className="text-right">
          <p className="text-body font-medium text-white truncate max-w-[200px]">{file.name}</p>
          <p className="text-meta text-white/75">{formatFileSize(file.size)}</p>
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
          {/* Amber stays a fixed value rather than becoming the warn token: the
              day theme's warn is a dark ochre chosen for LIGHT surfaces, and
              this pill sits on the viewer's fixed black. */}
          <span className="text-meta text-amber-400 font-medium bg-amber-500/10 px-3 py-1 rounded-full">
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
              'flex-1 bg-white/10 text-white placeholder-white/40 text-body rounded-2xl px-4 py-3',
              'border border-white/10 focus:outline-none focus:ring-2 focus:ring-acc focus:border-acc transition-all',
            )}
          />
          <IconButton
            size="lg"
            onClick={handleSend}
            className="bg-acc shadow-acc transition-all"
            aria-label="Send image"
          >
            <Send size={20} className="text-acc-on" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
