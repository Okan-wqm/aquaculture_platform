/**
 * SandboxedHtmlPreview — the only way to render untrusted HTML in the web tree.
 *
 * Operator-editable HTML (email templates, announcements, imported content)
 * rendered through a bare `<iframe srcDoc>` runs in the parent's origin: a
 * stored `<script>` reads localStorage, the auth context and every cookie the
 * parent can see. On the admin panel that is the SUPER_ADMIN session
 * (ADMIN-CRITICAL-015). The `sandbox` attribute is what removes that power,
 * and an attribute that a call site can forget is not a control.
 *
 * So the attribute is not a prop. `sandbox=""` — the empty token list — denies
 * scripts, forms, same-origin access, top-navigation, popups and plugins; the
 * document paints and nothing else. `referrerPolicy="no-referrer"` keeps the
 * admin URL out of any resource the HTML loads. There is deliberately no way
 * to widen either from a caller: a preview that needs scripts is not a
 * preview, it is an application, and it belongs in its own origin.
 *
 * Enforced by `aquaculture/no-unsandboxed-html-frame`: a raw `<iframe>`
 * without `sandbox`, or a `srcDoc` outside this file, fails lint.
 */
import React from 'react';

export interface SandboxedHtmlPreviewProps {
  /** Untrusted HTML document to display. Rendered inert. */
  html: string;
  /** Accessible name for the frame. */
  title: string;
  /** Layout classes for the frame element. */
  className?: string;
}

export const SandboxedHtmlPreview: React.FC<SandboxedHtmlPreviewProps> = ({
  html,
  title,
  className,
}) => (
  <iframe
    srcDoc={html}
    title={title}
    className={className}
    sandbox=""
    referrerPolicy="no-referrer"
    loading="lazy"
  />
);

SandboxedHtmlPreview.displayName = 'SandboxedHtmlPreview';
