/**
 * PageHeader is the page's title row (FE-MEDIUM-071): one h1, one
 * description line, the actions on the right, and room for tabs beneath.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageHeader } from '../PageHeader';

describe('PageHeader', () => {
  it('renders the title as the page heading with its description', () => {
    render(<PageHeader title="Devices" description="Edge controllers and sensors" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Devices' })).toBeTruthy();
    expect(screen.getByText('Edge controllers and sensors').tagName).toBe('P');
  });

  it('places actions beside the title and content beneath it', () => {
    render(
      <PageHeader title="Devices" actions={<button type="button">Add device</button>}>
        <nav aria-label="Sections">tabs</nav>
      </PageHeader>,
    );
    const header = screen.getByRole('banner');
    const heading = screen.getByRole('heading', { level: 1 });
    const action = screen.getByRole('button', { name: 'Add device' });
    const tabs = screen.getByRole('navigation', { name: 'Sections' });
    expect(header.contains(action)).toBe(true);
    // The actions share the title row; the children sit below it.
    expect(heading.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs.parentElement).toBe(header);
  });

  it('accepts a node title, an eyebrow and a leading element', () => {
    render(
      <PageHeader
        title={
          <>
            Tank <span>A-1</span>
          </>
        }
        eyebrow={<a href="/tanks">Back to tanks</a>}
        leading={<svg data-testid="icon" />}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Tank A-1');
    expect(screen.getByTestId('icon')).toBeTruthy();
    const back = screen.getByRole('link', { name: 'Back to tanks' });
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('paragraph')).toBeNull();
  });
});
