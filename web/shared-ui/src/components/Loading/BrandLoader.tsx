/**
 * BrandLoader — the one loading screen (FE-MEDIUM-349; owner decision,
 * 2026-10-17).
 *
 * WHAT: the Suderra mark, centred on the cream plate it has on the rail (so
 * the navy fish reads on the dark ground too), turning once every 1.8 s, with
 * "Loading…" beneath it; under reduced motion the mark does not turn and only
 * fades gently. A polite status whose announced text is a fuller label — what is
 * loading — while the visible word is hidden from it, so a screen reader
 * hears one sentence, not two. `screen` fills the viewport on the console
 * ground (the session check); `region` fills the area it stands in (a route
 * or a module loading inside the console).
 *
 * WHY its stylesheet is in web/shell/index.html: the boot splash there is
 * this component before React — the same markup, painted before any bundle
 * loads — and the two are one visual only with one stylesheet. Every
 * surface that shows a BrandLoader renders in the shell's document. The
 * colours are the console tokens once the theme is resolved (`data-theme`
 * on <html>), with a copy generated from theme.css standing in before that
 * and until the design system's CSS arrives
 * (tools/design/generate-boot-splash.ts). web/shell/src/__tests__/
 * bootSplash.spec.tsx holds the splash to this markup; useBootSplashTurn
 * carries the splash's turn across the hand-off.
 *
 * Spinner stays the inline indicator (a button, a small block); a session
 * check, a route or a module loads with this.
 */
import { useRef, type ReactElement } from 'react';

import { BRAND } from '../../config/brand';
import { useI18n } from '../../i18n';

import { useBootSplashTurn } from './bootSplashTurn';

/** The mark's box: the 553 × 464 logo at 72 px wide, fixed so nothing moves while it loads. */
const MARK_SIZE = { width: 72, height: 60 } as const;

export interface BrandLoaderProps {
  /** `screen` fills the viewport on the console ground; `region` (default) the area it stands in. */
  readonly variant?: 'screen' | 'region';
  /** What is loading, for screen readers; the visible word stays "Loading…". */
  readonly label?: string;
}

export function BrandLoader({ variant = 'region', label }: BrandLoaderProps): ReactElement {
  const { t } = useI18n();
  const mark = useRef<HTMLImageElement>(null);
  useBootSplashTurn(mark);

  return (
    <div role="status" aria-live="polite" className={`brand-loader brand-loader--${variant}`}>
      <span className="brand-loader__plate">
        <img
          ref={mark}
          className="brand-loader__mark"
          src={BRAND.mark}
          alt=""
          width={MARK_SIZE.width}
          height={MARK_SIZE.height}
        />
      </span>
      <span className="brand-loader__text" aria-hidden="true">
        {t('brandLoader.loading')}
      </span>
      <span className="sr-only">{label ?? t('brandLoader.label')}</span>
    </div>
  );
}
