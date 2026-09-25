/**
 * ToggleButton — a button whose selected state is announced, not only painted.
 *
 * The rescan found 281 buttons across the product whose className switches on a
 * selected state while the opening tag declares nothing: a screen reader hears
 * "button" for the selected tab, the active chart range, the enabled alert
 * channel and the picked storage location alike. Colour alone carries the
 * meaning, which WCAG 1.4.1 rejects (FE-HIGH-159).
 *
 * Every one of those sites had the state in hand — `activeTab === tab.id`,
 * `showFilters`, `tags.includes(tag)` — and spent it on `className` only. The
 * defect is therefore not carelessness but a missing primitive: nothing made
 * the announcement the zero-effort default. Here `pressed` is required and
 * drives BOTH sides, so a selected state cannot be painted without being
 * declared:
 *
 *   <ToggleButton
 *     pressed={activeView === 'overview'}
 *     onClick={() => setActiveView('overview')}
 *     className="rounded-md px-4 py-2 text-sm font-medium"
 *     pressedClassName="bg-info-100 text-info-700 dark:bg-info-900/40 dark:text-info-300"
 *     idleClassName="text-gray-500 hover:text-gray-700 dark:text-gray-400"
 *   >
 *
 * Children stay arbitrary on purpose. The sites are option cards with icons and
 * descriptions, toolbar pills, chips, mobile location rows — one fixed markup
 * would have to redesign all of them, and a primitive nobody can adopt fixes
 * nothing.
 *
 * WHERE THIS IS NOT THE ANSWER: a list-driven single-select strip is a keyboard
 * pattern, not a set of toggles — one tab stop, arrows between options, the
 * selected one naming its panel. `Tabs` already implements that (roving
 * tabindex, aria-controls, Home/End) and stays the target for tab strips. This
 * component deliberately claims only `aria-pressed`: declaring `role="radio"`
 * over children it cannot traverse would advertise a pattern it does not
 * implement, which reads worse to assistive technology than an honest toggle.
 */

import { forwardRef, ButtonHTMLAttributes } from 'react';
import { cn } from '../../utils';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface ToggleButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Seçili mi — hem `aria-pressed` hem de uygulanan sınıf bundan türer.
   * Zorunlu olması bu bileşenin varlık sebebidir: boyanan durum duyurulmadan
   * kalamaz.
   */
  pressed: boolean;
  /** Her iki durumda da uygulanan taban sınıflar */
  className?: string;
  /** Yalnızca seçiliyken uygulanan sınıflar */
  pressedClassName?: string;
  /** Yalnızca seçili değilken uygulanan sınıflar */
  idleClassName?: string;
  /**
   * `onClick` yerine durumu doğrudan alan kısayol; ikisi de verilirse ikisi de
   * çağrılır. Sıradaki durumu verir, böylece çağrı yeri onu yeniden türetmez.
   */
  onPressedChange?: (next: boolean) => void;
}

// ============================================================================
// ToggleButton Bileşeni
// ============================================================================

/** ToggleButton bileşeni — kullanım için yukarıdaki dosya başlığına bakın. */
export const ToggleButton = forwardRef<HTMLButtonElement, ToggleButtonProps>(
  (
    {
      pressed,
      className,
      pressedClassName,
      idleClassName,
      onPressedChange,
      onClick,
      type = 'button',
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      className={cn(className, pressed ? pressedClassName : idleClassName)}
      onClick={(event) => {
        onClick?.(event);
        onPressedChange?.(!pressed);
      }}
      {...props}
    >
      {children}
    </button>
  ),
);

ToggleButton.displayName = 'ToggleButton';
