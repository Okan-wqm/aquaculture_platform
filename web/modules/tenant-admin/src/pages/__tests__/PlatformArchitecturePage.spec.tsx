/**
 * PlatformArchitecturePage — the static "Platform architecture v4" reference
 * document at /tenant/architecture.
 *
 * The page has no data source (no hook to mock): it renders typed content
 * through the real shared-ui primitives (PageHeader, DataTable) and the real
 * i18n, which reads English without a provider. The tests pin the chrome
 * (localized title, contents, legend, column headers) and that the Turkish
 * body reaches the page whole: every section with its diagram, notes, rules
 * and tables.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import PlatformArchitecturePage from '../PlatformArchitecturePage';

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/tenant/architecture']}>
      <PlatformArchitecturePage />
    </MemoryRouter>,
  );
}

function sectionById(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`section #${id} is not rendered`);
  return element;
}

describe('PlatformArchitecturePage', () => {
  it('titles the page through i18n and links to the review', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Platform architecture' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Architecture review/ })).toHaveAttribute(
      'href',
      '/tenant/architecture/review',
    );
  });

  it('renders the document body in Turkish, marked as such', () => {
    renderPage();
    expect(screen.getByText('Platform nasıl bağlanır').closest('[lang="tr"]')).not.toBeNull();
  });

  it('lists the fourteen sections in the contents, each linking to its section', () => {
    renderPage();
    const toc = screen.getByRole('navigation', { name: 'Sections' });
    const links = within(toc).getAllByRole('link');
    expect(links).toHaveLength(14);
    expect(links[0]).toHaveAttribute('href', '#arch-01');
    expect(links[13]).toHaveTextContent('Hepsi birlikte');
    for (const item of links) {
      const target = item.getAttribute('href')?.slice(1) ?? '';
      expect(document.getElementById(target)).not.toBeNull();
    }
  });

  it('explains the diagram notation in the reader’s language', () => {
    renderPage();
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getByText('data flow')).toBeInTheDocument();
    expect(within(legend).getByText('link with a start and an end')).toBeInTheDocument();
  });

  it('draws each section’s diagram from its boxes, with notes and rules beneath', () => {
    renderPage();
    const facility = sectionById('arch-01');
    expect(
      within(facility).getByRole('heading', { level: 2, name: 'Tesis yapısı: yer, varlık, izin' }),
    ).toBeInTheDocument();
    const diagram = within(facility).getByRole('group', { name: 'Diagram of section 01' });
    expect(within(diagram).getByText('Pozisyon')).toBeInTheDocument();
    expect(within(diagram).getByText('takılı · tarihli')).toBeInTheDocument();
    expect(within(facility).getAllByRole('listitem').length).toBeGreaterThanOrEqual(7 + 3);
    const rules = within(facility).getByRole('list', { name: 'Rules' });
    expect(within(rules).getAllByRole('listitem')).toHaveLength(3);
  });

  it('renders §08’s two report tables with every row', () => {
    renderPage();
    const tables = within(sectionById('arch-08')).getAllByRole('table');
    expect(tables).toHaveLength(2);
    expect(within(tables[0]).getAllByRole('row')).toHaveLength(1 + 8);
    expect(within(tables[1]).getAllByRole('row')).toHaveLength(1 + 9);
    expect(within(tables[0]).getByText('Günlük ünite raporu')).toBeInTheDocument();
  });

  it('marks §08’s Turkish column headers as Turkish', () => {
    renderPage();
    const tables = within(sectionById('arch-08')).getAllByRole('table');
    const header = within(tables[0]).getByRole('columnheader', { name: 'Rapor' });
    expect(header.querySelector('[lang="tr"]')).not.toBeNull();
  });

  it('frames each table in a card that does not clip its corner marks', () => {
    // `.sd-card` draws its corner marks 6px outside the box; an overflow
    // class on the card itself would cut them off.
    renderPage();
    const tables = within(sectionById('arch-08')).getAllByRole('table');
    tables.forEach((table) => {
      const card = table.closest('.sd-card');
      expect(card).not.toBeNull();
      expect(Array.from(card?.classList ?? []).filter((c) => c.startsWith('overflow-'))).toEqual(
        [],
      );
    });
  });

  it('renders §14’s flow table under localized column headers', () => {
    renderPage();
    const table = within(sectionById('arch-14')).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Source' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Target' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'What flows' })).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 43);
  });
});
