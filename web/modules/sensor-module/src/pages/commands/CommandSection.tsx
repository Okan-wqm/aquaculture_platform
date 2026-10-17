/**
 * One section of the command log: a blueprint frame (`sd-card`), its h2 and
 * the sentence saying what the section records, an optional control on the
 * right (the drive picker), then the body.
 *
 * WHY `/page` container variants, not viewport breakpoints: the console sizes
 * its layout against the column beside the rail (the `page` container,
 * suderra.css), so the picker moves beside the heading when that column — not
 * the window — has room.
 *
 * WHY a `section` named by its heading: each source of command records is a
 * landmark a screen-reader user can jump to, and the preview sections can be
 * told apart from the recorded ones by name.
 */
import React, { useId } from 'react';

export interface CommandSectionProps {
  title: string;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function CommandSection({
  title,
  description,
  actions,
  children,
}: CommandSectionProps): React.JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="sd-card">
      <header className="flex flex-col gap-3 border-b border-gray-200 px-5 py-4 @min-[640px]/page:flex-row @min-[640px]/page:items-end @min-[640px]/page:justify-between dark:border-gray-700">
        <div className="min-w-0">
          <h2 id={headingId} className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h2>
          <p className="mt-1 max-w-[72ch] text-sm text-gray-600 dark:text-gray-400">
            {description}
          </p>
        </div>
        {actions !== undefined ? (
          <div className="w-full shrink-0 @min-[640px]/page:w-72">{actions}</div>
        ) : null}
      </header>
      {children}
    </section>
  );
}
