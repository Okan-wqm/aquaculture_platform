/**
 * PageHeader is the page's title row (FE-MEDIUM-071): one h1, one
 * description line, the actions on the right, and room for tabs beneath.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageHeader } from '../PageHeader';
import { PageTitle, PageTitleScope } from '../PageTitleScope';

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

/**
 * Inside the tenant console the header's h1 names the page (README §4), so a
 * PageHeader below the console's PageTitleScope must not add a second h1 —
 * whichever shell hosts the (federated) page, the page itself is unchanged.
 */
describe('PageHeader under a PageTitleScope', () => {
  it('keeps the title as the h1 outside any scope and under the heading scope', () => {
    render(
      <PageTitleScope mode="heading">
        <PageHeader title="Devices" />
      </PageTitleScope>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Devices' })).toBeTruthy();
  });

  it('hides a title the console h1 already says, keeping description and actions', () => {
    render(
      <PageTitleScope mode="hidden">
        <PageHeader
          title="Devices"
          description="Edge controllers and sensors"
          actions={<button type="button">Add device</button>}
        />
      </PageTitleScope>,
    );
    expect(screen.queryByRole('heading')).toBeNull();
    // Still read out, never drawn: assistive technology keeps the page's own words.
    expect(screen.getByText('Devices')).toHaveClass('sr-only');
    expect(screen.getByText('Edge controllers and sensors')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add device' })).toBeTruthy();
  });

  // Heading navigation must find the record (a tank, a device); the console
  // h1 above stays the only h1.
  it('shows a record title under the console h1 as a visible h2', () => {
    render(
      <PageTitleScope mode="subtitle">
        <PageHeader title="Tank A-1" description="Pond 3" />
      </PageTitleScope>,
    );
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    const title = screen.getByRole('heading', { level: 2, name: 'Tank A-1' });
    expect(title).not.toHaveClass('sr-only');
  });
});

/**
 * A page whose title is one control in its own toolbar (a SCADA view, a
 * simulator strip) writes it through PageTitle, which follows the same scope.
 */
describe('PageTitle', () => {
  it('is the h1 outside the console', () => {
    render(<PageTitle className="text-xl">SCADA view</PageTitle>);
    expect(screen.getByRole('heading', { level: 1, name: 'SCADA view' })).toHaveClass('text-xl');
  });

  it('defers to the console h1 inside its scope', () => {
    const { rerender } = render(
      <PageTitleScope mode="hidden">
        <PageTitle className="text-xl">SCADA view</PageTitle>
      </PageTitleScope>,
    );
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('SCADA view')).toHaveClass('sr-only');

    rerender(
      <PageTitleScope mode="subtitle">
        <PageTitle className="text-xl">SCADA view</PageTitle>
      </PageTitleScope>,
    );
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'SCADA view' })).toHaveClass('text-xl');
  });
});
