/**
 * MediaViewerPage -- Full-screen media viewer with pinch-to-zoom.
 *
 * WHY this design: Field workers share photos of tank conditions, equipment
 * issues, and water quality readings. A dedicated full-screen viewer with
 * pinch-to-zoom lets them inspect images in detail. Swipe navigation allows
 * browsing through all media in a channel without returning to the chat.
 *
 * Supports images (with CSS transform pinch-to-zoom), PDFs (filename +
 * download button), and loading states while fetching presigned URLs.
 *
 * WHY this screen keeps a black ground and white chrome instead of taking the
 * surface/ink tokens: a lightbox is a neutral viewing booth. The photo IS the
 * content, and judging a tank photo's colour against a tinted surface — or a
 * light one in the day theme — misreads the water. So the chrome here is
 * deliberately theme-independent; the tokens still govern everything else.
 */

import {
  X,
  Download,
  ChevronLeft,
  ChevronRight,
  FileText,
  AlertCircle,
} from 'lucide-react';
import { useState, useCallback, useRef, useEffect, useMemo, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { IconButton } from '@/components/ui';
import { useMessages } from '@/hooks/useMessages';
import type { Message, MessageAttachment } from '@/types/messaging';
import { getUserDisplayName, isSafeUrl } from '@/utils/messaging-helpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MediaItem {
  id: string;
  type: 'IMAGE' | 'PDF' | 'FILE';
  url: string;
  fileName: string;
  senderName: string;
  sentAt: string;
}

function classifyAttachment(attachment: MessageAttachment): MediaItem['type'] {
  if (attachment.mimeType.startsWith('image/')) return 'IMAGE';
  if (attachment.mimeType === 'application/pdf') return 'PDF';
  return 'FILE';
}

function mapMessageAttachment(message: Message, attachment: MessageAttachment): MediaItem | null {
  const url = attachment.downloadUrl;
  if (!url) return null;
  return {
    id: attachment.id,
    type: classifyAttachment(attachment),
    url,
    fileName: attachment.originalFilename,
    senderName: message.sender ? getUserDisplayName(message.sender) : message.senderId,
    sentAt: message.createdAt,
  };
}

function flattenMessageMedia(messages: readonly Message[]): MediaItem[] {
  const media: MediaItem[] = [];
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const item = mapMessageAttachment(message, attachment);
      if (item) media.push(item);
    }
  }
  return media;
}

function useChannelMedia(channelId: string | undefined, attachmentId: string | undefined): {
  media: MediaItem[];
  loading: boolean;
  error: string | null;
} {
  const {
    messages,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMessages(channelId);

  const media = useMemo(() => flattenMessageMedia(messages), [messages]);
  const hasCurrentAttachment = !!attachmentId && media.some((item) => item.id === attachmentId);

  useEffect(() => {
    if (!channelId || !attachmentId) return;
    if (isLoading || hasCurrentAttachment || !hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [
    attachmentId,
    channelId,
    fetchNextPage,
    hasCurrentAttachment,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  ]);

  const lookupInProgress =
    !!attachmentId && !hasCurrentAttachment && !!hasNextPage && isFetchingNextPage;

  return {
    media,
    loading: isLoading || lookupInProgress,
    error: !channelId
      ? 'Channel context missing for this media item'
      : error instanceof Error
        ? error.message
        : error
          ? String(error)
          : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Trigger a file download by creating a short-lived anchor element.
 * Only allows downloads from safe URL protocols (http/https).
 */
function downloadFile(url: string, fileName: string): void {
  if (!isSafeUrl(url)) return;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * Format a timestamp for display in the media viewer.
 */
function formatMediaDate(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * MediaViewerPage provides a full-screen media viewing experience with
 * pinch-to-zoom for images, swipe navigation between media items, and
 * download capability. PDF files display a filename card with download.
 *
 * Route: /messages/:channelId/media/:attachmentId
 */
export function MediaViewerPage(): JSX.Element {
  const navigate = useNavigate();
  const { channelId, attachmentId } = useParams<{
    channelId?: string;
    attachmentId: string;
  }>();

  const { media, loading, error } = useChannelMedia(channelId, attachmentId);

  // Find the current media index
  const currentIndex = media.findIndex((m) => m.id === attachmentId);
  const [activeIndex, setActiveIndex] = useState(
    currentIndex >= 0 ? currentIndex : 0,
  );

  // Keep activeIndex in sync when media loads
  useEffect(() => {
    if (media.length > 0 && attachmentId) {
      const idx = media.findIndex((m) => m.id === attachmentId);
      if (idx >= 0) setActiveIndex(idx);
    }
  }, [media, attachmentId]);

  const currentMedia = currentIndex >= 0 ? (media[activeIndex] ?? null) : null;

  // Pinch-to-zoom state
  const [scale, setScale] = useState(1);
  const [translateX, setTranslateX] = useState(0);
  const [translateY, setTranslateY] = useState(0);
  const initialPinchDistance = useRef<number | null>(null);
  const initialScale = useRef(1);
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  // Swipe detection for navigation
  const touchStartX = useRef<number | null>(null);

  // Reset zoom when changing images
  const resetZoom = useCallback(() => {
    setScale(1);
    setTranslateX(0);
    setTranslateY(0);
  }, []);

  const handlePrev = useCallback(() => {
    if (activeIndex > 0) {
      setActiveIndex((prev) => prev - 1);
      resetZoom();
    }
  }, [activeIndex, resetZoom]);

  const handleNext = useCallback(() => {
    if (activeIndex < media.length - 1) {
      setActiveIndex((prev) => prev + 1);
      resetZoom();
    }
  }, [activeIndex, media.length, resetZoom]);

  // Touch handlers for pinch-to-zoom and swipe
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDistance.current = Math.hypot(dx, dy);
        initialScale.current = scale;
      } else if (e.touches.length === 1) {
        if (scale > 1) {
          lastTouchPos.current = {
            x: e.touches[0].clientX,
            y: e.touches[0].clientY,
          };
        } else {
          touchStartX.current = e.touches[0].clientX;
        }
      }
    },
    [scale],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2 && initialPinchDistance.current !== null) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.hypot(dx, dy);
        const newScale = Math.min(
          Math.max(initialScale.current * (distance / initialPinchDistance.current), 0.5),
          4,
        );
        setScale(newScale);
      } else if (e.touches.length === 1 && scale > 1 && lastTouchPos.current) {
        const dx = e.touches[0].clientX - lastTouchPos.current.x;
        const dy = e.touches[0].clientY - lastTouchPos.current.y;
        setTranslateX((prev) => prev + dx);
        setTranslateY((prev) => prev + dy);
        lastTouchPos.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
        };
      }
    },
    [scale],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (initialPinchDistance.current !== null) {
        initialPinchDistance.current = null;
        if (scale < 1) {
          setScale(1);
          setTranslateX(0);
          setTranslateY(0);
        }
        return;
      }

      if (scale <= 1 && touchStartX.current !== null && e.changedTouches.length > 0) {
        const endX = e.changedTouches[0].clientX;
        const diff = touchStartX.current - endX;
        const threshold = 80;

        if (diff > threshold) {
          handleNext();
        } else if (diff < -threshold) {
          handlePrev();
        }
        touchStartX.current = null;
      }

      lastTouchPos.current = null;
    },
    [scale, handleNext, handlePrev],
  );

  // Double-tap to toggle zoom
  const lastTapTime = useRef(0);
  const handleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapTime.current < 300) {
      if (scale > 1) {
        resetZoom();
      } else {
        setScale(2.5);
      }
    }
    lastTapTime.current = now;
  }, [scale, resetZoom]);

  const handleDownload = useCallback(() => {
    if (!currentMedia) return;
    downloadFile(currentMedia.url, currentMedia.fileName);
  }, [currentMedia]);

  const handleClose = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  // Validate current media URL before rendering
  const safeMediaUrl = currentMedia?.url && isSafeUrl(currentMedia.url) ? currentMedia.url : null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 pt-safe-top bg-black/60 backdrop-blur-sm z-10">
        {/* IconButton carries the 48px target, the touch affordance and the
            focus ring, so the hand-rolled w-12/h-12 pair goes away. */}
        <IconButton size="lg" onClick={handleClose} className="hover:bg-white/10" aria-label="Close">
          <X size={24} className="text-white" />
        </IconButton>

        {currentMedia && (
          <div className="flex-1 text-center min-w-0 px-2">
            <p className="text-body font-medium text-white truncate">
              {currentMedia.senderName}
            </p>
            {/* text-meta is 12px, the sunlight floor — it replaces an 11px
                arbitrary size, so it LOWERS the tiny-text ratchet. */}
            <p className="text-meta text-white/75">
              {formatMediaDate(currentMedia.sentAt)}
            </p>
          </div>
        )}

        <IconButton
          size="lg"
          onClick={handleDownload}
          disabled={!currentMedia}
          className="hover:bg-white/10"
          aria-label="Download"
        >
          <Download size={22} className="text-white" />
        </IconButton>
      </div>

      {/* Main content */}
      <div
        ref={imageContainerRef}
        className="flex-1 flex items-center justify-center overflow-hidden relative"
        role="button"
        tabIndex={0}
        aria-label="Media viewer — activate to toggle zoom"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handleTap}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleTap();
          }
        }}
      >
        {loading ? (
          <div className="flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-10 w-10 border-2 border-white border-t-transparent" />
            <p className="text-body text-white/75">Loading media...</p>
          </div>
        ) : error ? (
          // A load failure is announced; "no media here" is not. The kit's
          // EmptyState is skipped on this screen only because its ink tokens
          // would render dark-on-black in the day theme.
          <div className="flex flex-col items-center gap-3 px-6 text-center" role="alert">
            <AlertCircle size={40} className="text-white/75" />
            <p className="text-body text-white/75">{error}</p>
          </div>
        ) : !currentMedia ? (
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <AlertCircle size={40} className="text-white/75" />
            <p className="text-body text-white/75">Media not found</p>
          </div>
        ) : currentMedia.type === 'IMAGE' && safeMediaUrl ? (
          <img
            src={safeMediaUrl}
            alt={currentMedia.fileName}
            className="max-w-full max-h-full object-contain select-none"
            draggable={false}
            style={{
              transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
              transition:
                initialPinchDistance.current !== null || lastTouchPos.current
                  ? 'none'
                  : 'transform 0.2s ease-out',
            }}
          />
        ) : currentMedia.type === 'PDF' ? (
          <div className="bg-white/10 backdrop-blur-sm rounded-2xl p-8 flex flex-col items-center gap-4 max-w-xs w-full mx-6">
            {/* WHY the PDF tile is no longer red: in v4 coral means ALARM, and
                nothing else may borrow it — a red document icon spends the one
                colour the app uses to say "something is wrong" on a file type.
                The kind is already stated in words underneath. */}
            <div className="w-20 h-20 bg-white/10 rounded-2xl flex items-center justify-center">
              <FileText size={40} className="text-white/75" />
            </div>
            <div className="text-center">
              <p className="text-body font-semibold text-white truncate max-w-[200px]">
                {currentMedia.fileName}
              </p>
              <p className="text-meta text-white/75 mt-1">PDF Document</p>
            </div>
            <button
              onClick={handleDownload}
              className="w-full py-3 min-h-touch bg-white/20 hover:bg-white/30 text-white font-semibold rounded-xl touch-feedback transition-all flex items-center justify-center gap-2 text-body"
            >
              <Download size={18} />
              Download
            </button>
          </div>
        ) : (
          <div className="bg-white/10 backdrop-blur-sm rounded-2xl p-8 flex flex-col items-center gap-4 max-w-xs w-full mx-6">
            <div className="w-20 h-20 bg-white/10 rounded-2xl flex items-center justify-center">
              <FileText size={40} className="text-white/75" />
            </div>
            <div className="text-center">
              <p className="text-body font-semibold text-white truncate max-w-[200px]">
                {currentMedia.fileName}
              </p>
            </div>
            <button
              onClick={handleDownload}
              className="w-full py-3 min-h-touch bg-white/20 hover:bg-white/30 text-white font-semibold rounded-xl touch-feedback transition-all flex items-center justify-center gap-2 text-body"
            >
              <Download size={18} />
              Download
            </button>
          </div>
        )}
      </div>

      {/* Navigation arrows */}
      {media.length > 1 && (
        <>
          {activeIndex > 0 && (
            <IconButton
              size="lg"
              onClick={handlePrev}
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/50 transition-all z-10"
              aria-label="Previous"
            >
              <ChevronLeft size={24} className="text-white" />
            </IconButton>
          )}
          {activeIndex < media.length - 1 && (
            <IconButton
              size="lg"
              onClick={handleNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/50 transition-all z-10"
              aria-label="Next"
            >
              <ChevronRight size={24} className="text-white" />
            </IconButton>
          )}
        </>
      )}

      {/* Bottom indicator dots */}
      {media.length > 1 && media.length <= 20 && (
        <div className="flex items-center justify-center gap-1.5 py-4 pb-safe bg-black/40">
          {media.map((_, idx) => (
            <div
              key={idx}
              className={`w-1.5 h-1.5 rounded-full transition-all ${
                idx === activeIndex
                  ? 'bg-white w-4'
                  : 'bg-white/40'
              }`}
            />
          ))}
        </div>
      )}

      {/* Counter for many items */}
      {media.length > 20 && (
        <div className="flex items-center justify-center py-4 pb-safe bg-black/40">
          <span className="text-meta text-white/75 font-medium tabular-nums">
            {activeIndex + 1} / {media.length}
          </span>
        </div>
      )}
    </div>
  );
}
