/**
 * SandboxedHtmlPreview — the sandbox cannot be omitted or widened by a caller.
 *
 * ADMIN-CRITICAL-015: an operator-editable template rendered through a bare
 * `<iframe srcDoc>` was a same-origin path to the SUPER_ADMIN session.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { SandboxedHtmlPreview } from '../SandboxedHtmlPreview';

describe('SandboxedHtmlPreview', () => {
  const html = '<p>hello</p><script>window.parent.document.title = "pwned"</script>';

  it('renders the document in an iframe with an EMPTY sandbox token list', () => {
    const { container } = render(<SandboxedHtmlPreview html={html} title="Email Preview" />);
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('srcdoc')).toBe(html);
    expect(frame?.getAttribute('title')).toBe('Email Preview');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('exposes no prop that can widen the sandbox', () => {
    // The props type is the contract: html, title, className — nothing else.
    // A `sandbox` or `allow` prop would be a caller-controlled escape hatch, so
    // its absence is asserted at the type level (this file fails to compile if
    // one is ever added) and the rendered attribute stays empty regardless.
    type Props = React.ComponentProps<typeof SandboxedHtmlPreview>;
    const sandboxIsNotAProp: 'sandbox' extends keyof Props ? false : true = true;
    const allowIsNotAProp: 'allow' extends keyof Props ? false : true = true;
    expect(sandboxIsNotAProp && allowIsNotAProp).toBe(true);

    const { container } = render(<SandboxedHtmlPreview html={html} title="t" className="c" />);
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
  });
});
