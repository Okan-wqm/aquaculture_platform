/**
 * QueryFailureNotice — the condition four pages each wrote and each got wrong
 * in the same direction (ADMIN-HIGH-121).
 *
 * `AuditTrailPage`, `SecurityDashboardPage` and `ActivityLogPage` all spent
 * dozens of lines collecting a `failures[]` from settled promises, then
 * rendered it under `error && <content>.length === 0`. So the case that
 * actually happens — some queries succeed, one fails — showed empty sections
 * with no indication anything had failed. The middle case below is that bug;
 * everything else is the surrounding behaviour it has to keep.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import { QueryFailureNotice } from '../QueryFailureNotice';

describe('QueryFailureNotice', () => {
  it('renders nothing when every query succeeded', () => {
    const { container } = render(
      <QueryFailureNotice errors={[null, undefined]} hasContent onRetry={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('reports a partial failure WITHOUT hiding the content that loaded', () => {
    // The regression. Before this component the message existed and the render
    // threw it away whenever `hasContent` was true — which is exactly when an
    // operator is looking at the page and most likely to trust it.
    render(
      <QueryFailureNotice
        errors={[null, new Error('threat intelligence unavailable')]}
        hasContent
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('threat intelligence unavailable');
  });

  it('joins every failure so one outage does not mask another', () => {
    render(
      <QueryFailureNotice
        errors={[new Error('events unavailable'), new Error('incidents unavailable')]}
        hasContent
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'events unavailable; incidents unavailable',
    );
  });

  it('takes over the page only when nothing loaded', () => {
    render(
      <QueryFailureNotice
        errors={[new Error('dashboard unavailable')]}
        hasContent={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('dashboard unavailable');
  });

  it('offers the same retry in both states', async () => {
    const user = userEvent.setup();

    const partialRetry = vi.fn();
    const { unmount } = render(
      <QueryFailureNotice errors={[new Error('x')]} hasContent onRetry={partialRetry} />,
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(partialRetry).toHaveBeenCalledTimes(1);
    unmount();

    const fullRetry = vi.fn();
    render(<QueryFailureNotice errors={[new Error('x')]} hasContent={false} onRetry={fullRetry} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fullRetry).toHaveBeenCalledTimes(1);
  });

  it('ignores non-Error entries rather than rendering an empty alert', () => {
    // Callers pass `query.error` straight through; a query that has not failed
    // contributes `null`, and a notice must not appear for it.
    const { container } = render(
      <QueryFailureNotice errors={[null, null, null]} hasContent={false} onRetry={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
