/**
 * RuntimePipe — Animated flow pipe widget for SCADA operator mode.
 *
 * Renders an SVG path-based pipe with animated flow using the
 * strokeDashoffset technique (FUXA pattern):
 *   - A dashed stroke animates along the pipe path via CSS animation
 *     when flow direction is 'forward' or 'reverse'
 *   - Direction 'stop' freezes the animation
 *
 * Architecture:
 *   - The pipe outline (border) is a thick stroke on the SVG path
 *   - The pipe interior (pipe color) is a thinner stroke on the same path
 *   - The flow content (dashes) is an animated dashed stroke on the same path
 *   - Optional image animation: small <image> elements travel along the path
 *     using CSS animation with animationDelay staggering
 *
 * Performance:
 *   - CSS @keyframes animation runs on compositor thread — no JS timers
 *   - requestAnimationFrame only used for image position tracking
 *   - Animation is paused when widget is hidden (visibility:hidden)
 *   - React.memo prevents re-renders from unrelated parent updates
 */

import React, { memo, useEffect, useRef, useMemo } from 'react';
import type { RuntimeWidgetProps, PipeConfig, PipeFlowDirection } from '../../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Style injection (once per document)                                */
/* ------------------------------------------------------------------ */

let pipeStyleInjected = false;

function injectPipeStyles(): void {
  if (pipeStyleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
@keyframes pipeFlowForward {
  from { stroke-dashoffset: 0; }
  to   { stroke-dashoffset: -40; }
}
@keyframes pipeFlowReverse {
  from { stroke-dashoffset: 0; }
  to   { stroke-dashoffset: 40; }
}
`;
  document.head.appendChild(style);
  pipeStyleInjected = true;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Return animation CSS for the content stroke. */
function flowAnimation(
  direction: PipeFlowDirection,
  speedMs: number,
): React.CSSProperties {
  if (direction === 'stop') return { animation: 'none' };
  const name =
    direction === 'forward' ? 'pipeFlowForward' : 'pipeFlowReverse';
  return {
    animation: `${name} ${speedMs}ms linear infinite`,
    animationPlayState: 'running',
  };
}

/** Build a default horizontal pipe path spanning the widget. */
function defaultPipePath(width: number, height: number): string {
  const midY = height / 2;
  return `M 8 ${midY} L ${width - 8} ${midY}`;
}

/* ------------------------------------------------------------------ */
/*  ImageAnimator — images that travel along the pipe path             */
/* ------------------------------------------------------------------ */

interface ImageAnimatorProps {
  pathEl: SVGPathElement | null;
  imageUrl: string;
  count: number;
  delayMs: number;
  direction: PipeFlowDirection;
  speedMs: number;
  imageSize?: number;
}

/**
 * Uses requestAnimationFrame to move <image> elements along the SVGPathElement.
 * Only active when direction != 'stop' and pathEl is available.
 */
const ImageAnimator = memo<ImageAnimatorProps>(
  ({ pathEl, imageUrl, count, delayMs, direction, speedMs, imageSize = 16 }) => {
    const imagesRef = useRef<SVGImageElement[]>([]);
    const rafRef = useRef<number | null>(null);
    const startTimesRef = useRef<number[]>([]);
    const lastDirectionRef = useRef<PipeFlowDirection>(direction);

    useEffect(() => {
      if (!pathEl || direction === 'stop') {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        return;
      }

      const totalLength = pathEl.getTotalLength();
      if (totalLength === 0) return;

      const now = performance.now();
      // Initialise staggered start times on direction change
      if (lastDirectionRef.current !== direction || startTimesRef.current.length !== count) {
        startTimesRef.current = Array.from({ length: count }, (_, i) =>
          now - (i / count) * speedMs,
        );
        lastDirectionRef.current = direction;
      }

      const tick = (ts: number) => {
        imagesRef.current.forEach((img, i) => {
          if (!img) return;
          const elapsed = (ts - startTimesRef.current[i] + i * delayMs) % speedMs;
          const rawT = elapsed / speedMs;
          const t = direction === 'reverse' ? 1 - rawT : rawT;
          const dist = t * totalLength;
          const pt = pathEl.getPointAtLength(dist);
          img.setAttribute('x', String(pt.x - imageSize / 2));
          img.setAttribute('y', String(pt.y - imageSize / 2));
        });
        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);

      return () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };
    }, [pathEl, direction, speedMs, count, delayMs, imageSize]);

    return (
      <>
        {Array.from({ length: count }, (_, i) => (
          <image
            key={i}
            ref={(el) => {
              if (el) imagesRef.current[i] = el;
            }}
            href={imageUrl}
            width={imageSize}
            height={imageSize}
            style={{ pointerEvents: 'none' }}
          />
        ))}
      </>
    );
  },
);
ImageAnimator.displayName = 'ImageAnimator';

/* ------------------------------------------------------------------ */
/*  RuntimePipe                                                         */
/* ------------------------------------------------------------------ */

const RuntimePipe: React.FC<RuntimeWidgetProps> = ({
  config,
  width = 200,
  height = 60,
  actions,
  isVisible = true,
}) => {
  // Inject CSS animation keyframes once
  useEffect(injectPipeStyles, []);

  /* ---- config ---- */
  const pipeConfig = config as unknown as Partial<PipeConfig>;

  const borderColor  = (pipeConfig.borderColor  ?? '#374151') as string;
  const borderWidth  = Number(pipeConfig.borderWidth  ?? 4);
  const pipeColor    = (pipeConfig.pipeColor    ?? '#6b7280') as string;
  const pipeWidth    = Number(pipeConfig.pipeWidth    ?? 16);
  const contentColor = (pipeConfig.contentColor ?? '#06b6d4') as string;
  const contentWidth = Number(pipeConfig.contentWidth ?? 8);
  const contentSpace = Number(pipeConfig.contentSpace ?? 8);
  const speedMs      = Number((config.speedMs ?? 1200) as number);

  // Custom path from config, or auto-generated horizontal pipe
  const pathData = (config.path ?? defaultPipePath(width, height)) as string;

  // Image animation
  const imgAnim = pipeConfig.imageAnimation;

  /* ---- flow direction — derived from widget actions result ---- */
  // The RuntimeWidgetRenderer computes animationDirection via useWidgetActions
  // and passes it down in the actions array. We also accept a direct config override.
  const configDirection = (config.flowDirection ?? 'forward') as PipeFlowDirection;

  // Find first matching 'animate' action in the passed actions array
  const actionDirection = useMemo(() => {
    if (!actions) return null;
    for (const a of actions) {
      if (a.type === 'animate') {
        const ap = a.params as { direction?: PipeFlowDirection };
        return ap.direction ?? null;
      }
    }
    return null;
  }, [actions]);

  const direction: PipeFlowDirection = actionDirection ?? configDirection;

  /* ---- SVG path ref (for image animator) ---- */
  const pathRef = useRef<SVGPathElement | null>(null);

  /* ---- dash pattern ---- */
  // dash = contentWidth, gap = contentSpace
  const dashArray = `${contentWidth} ${contentSpace}`;

  /* ---- animation style ---- */
  const animStyle = useMemo(
    () => flowAnimation(direction, speedMs),
    [direction, speedMs],
  );

  return (
    <div
      className="w-full h-full"
      aria-label="Flow pipe"
      role="img"
      style={{ visibility: isVisible ? 'visible' : 'hidden' }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block overflow-visible"
      >
        {/* Pipe border (outermost, widest stroke) */}
        <path
          d={pathData}
          fill="none"
          stroke={borderColor}
          strokeWidth={pipeWidth + borderWidth * 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Pipe body */}
        <path
          d={pathData}
          fill="none"
          stroke={pipeColor}
          strokeWidth={pipeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Animated flow content dashes */}
        <path
          ref={pathRef}
          d={pathData}
          fill="none"
          stroke={direction === 'stop' ? 'transparent' : contentColor}
          strokeWidth={contentWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={dashArray}
          style={animStyle}
        />

        {/* Image animation along pipe (optional) */}
        {imgAnim && imgAnim.imageUrl && imgAnim.count > 0 && (
          <ImageAnimator
            pathEl={pathRef.current}
            imageUrl={imgAnim.imageUrl}
            count={imgAnim.count}
            delayMs={imgAnim.delayMs ?? 200}
            direction={direction}
            speedMs={speedMs}
          />
        )}
      </svg>
    </div>
  );
};

RuntimePipe.displayName = 'RuntimePipe';
export default memo(RuntimePipe);
