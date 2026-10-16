/**
 * ArchitectureReviewPage — the static end-to-end logic review of the platform
 * architecture at /tenant/architecture/review.
 *
 * No data source: typed content through the real shared-ui primitives and
 * the real i18n (English without a provider). The tests pin what a reader
 * relies on: the counts are computed from the findings, each finding carries
 * its id, kind and recommendation, and every cross-reference (priority,
 * scenario, contents) lands on a part the page renders.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import ArchitectureReviewPage from '../ArchitectureReviewPage';

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/tenant/architecture/review']}>
      <ArchitectureReviewPage />
    </MemoryRouter>,
  );
}

function partById(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`part #${id} is not rendered`);
  return element;
}

function expectInPageTarget(link: HTMLElement): void {
  const target = link.getAttribute('href')?.slice(1) ?? '';
  expect(document.getElementById(target)).not.toBeNull();
}

describe('ArchitectureReviewPage', () => {
  it('titles the page through i18n and links back to the architecture', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Architecture review' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Platform architecture/ })).toHaveAttribute(
      'href',
      '/tenant/architecture',
    );
    expect(screen.getByText('Uçtan uca mantık incelemesi').closest('[lang="tr"]')).not.toBeNull();
  });

  it('counts the findings by kind', () => {
    renderPage();
    const stats = screen.getByRole('list', { name: 'Findings by kind' });
    const tile = (label: string): HTMLElement | null =>
      within(stats).getByText(label).closest('li');
    expect(tile('Findings')).toHaveTextContent('64');
    expect(tile('Contradiction')).toHaveTextContent('10');
    expect(tile('Gap')).toHaveTextContent('27');
    expect(tile('Missing rule')).toHaveTextContent('21');
    expect(tile('Edge case')).toHaveTextContent('6');
  });

  it('lists the eleven sections and the three closing parts in the contents', () => {
    renderPage();
    const links = within(screen.getByRole('navigation', { name: 'Sections' })).getAllByRole('link');
    expect(links).toHaveLength(14);
    expect(links[0]).toHaveTextContent('Tesis yapısı');
    expect(links[0]).toHaveTextContent('6');
    links.forEach(expectInPageTarget);
  });

  it('shows each finding with its id, kind, title and recommendation', () => {
    renderPage();
    const facility = partById('review-r01');
    const findings = within(facility).getAllByRole('listitem');
    expect(findings).toHaveLength(6);
    const first = findings[0];
    expect(first).toHaveTextContent('01.1');
    expect(within(first).getByText('Contradiction')).toBeInTheDocument();
    expect(
      within(first).getByRole('heading', { level: 3, name: 'Depo nedir?' }),
    ).toBeInTheDocument();
    expect(within(first).getByText('Recommendation')).toBeInTheDocument();
  });

  it('opens with the eight priorities, each linking to its finding', () => {
    renderPage();
    const priorities = partById('review-top');
    expect(within(priorities).getAllByRole('listitem')).toHaveLength(8);
    within(priorities).getAllByRole('link').forEach(expectInPageTarget);
  });

  it('closes with the cross-cutting topics and the proposed sections and flows', () => {
    renderPage();
    expect(within(partById('review-rk')).getAllByRole('listitem')).toHaveLength(10);
    const proposals = partById('review-ro');
    expect(
      within(proposals).getByRole('heading', { level: 3, name: 'Kontrol' }),
    ).toBeInTheDocument();
    const flows = within(proposals).getByRole('table');
    expect(within(flows).getByRole('columnheader', { name: 'Why' })).toBeInTheDocument();
    expect(within(flows).getAllByRole('row')).toHaveLength(1 + 14);
  });

  it('checks the twenty scenarios, counting them by status', () => {
    renderPage();
    const check = partById('review-rs');
    const counts = within(check).getByRole('list', { name: 'Scenarios by status' });
    expect(within(counts).getByText('Covered').closest('li')).toHaveTextContent('3');
    expect(within(counts).getByText('Partly').closest('li')).toHaveTextContent('8');
    expect(within(counts).getByText('Not covered').closest('li')).toHaveTextContent('9');
    const table = within(check).getByRole('table');
    expect(
      within(table).getByRole('columnheader', { name: 'What happens today' }),
    ).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 20);
    within(table).getAllByRole('link').forEach(expectInPageTarget);
  });
});
