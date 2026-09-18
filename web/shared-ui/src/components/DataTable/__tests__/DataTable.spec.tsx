/**
 * DataTable — the states pages used to hand-roll around it (FE-HIGH-069).
 *
 * Pins the two behaviours that made a raw <table> look easier than adopting
 * DataTable: a toolbar strip that appeared with nothing in it, and an empty
 * body that could only say one line.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DataTable, type DataTableColumn } from '../index';

interface Row {
  id: string;
  name: string;
}

const columns: DataTableColumn<Row>[] = [{ key: 'name', header: 'Name' }];
const rows: readonly Row[] = [{ id: '1', name: 'Ada' }];

describe('DataTable — toolbar', () => {
  it('renders no toolbar when the page owns its own filters', () => {
    render(
      <DataTable<Row>
        data={rows}
        columns={columns}
        keyExtractor={(row) => row.id}
        searchable={false}
      />,
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    expect(screen.getByText('Ada')).toBeTruthy();
  });

  it('renders the search box when asked', () => {
    render(<DataTable<Row> data={rows} columns={columns} keyExtractor={(row) => row.id} searchable />);
    expect(screen.getByPlaceholderText(/search/i)).toBeTruthy();
  });
});

describe('DataTable — empty body', () => {
  it('says the string it is given', () => {
    render(
      <DataTable<Row>
        data={[]}
        columns={columns}
        keyExtractor={(row) => row.id}
        searchable={false}
        emptyMessage="No users found"
      />,
    );
    expect(screen.getByText('No users found')).toBeTruthy();
  });

  it('renders a heading-plus-hint node, so a page needs no second empty state below the table', () => {
    render(
      <DataTable<Row>
        data={[]}
        columns={columns}
        keyExtractor={(row) => row.id}
        searchable={false}
        emptyIcon={<span data-testid="empty-icon" />}
        emptyMessage={
          <>
            <h3>No users yet</h3>
            <p>Add users to your tenant to get started.</p>
          </>
        }
      />,
    );
    expect(screen.getByRole('heading', { name: 'No users yet' })).toBeTruthy();
    expect(screen.getByText('Add users to your tenant to get started.')).toBeTruthy();
    expect(screen.getByTestId('empty-icon')).toBeTruthy();
  });

  it('shows the loading message instead of the empty state while loading', () => {
    render(
      <DataTable<Row>
        data={[]}
        columns={columns}
        keyExtractor={(row) => row.id}
        searchable={false}
        loading
        loadingMessage="Loading users"
        emptyMessage="No users found"
      />,
    );
    expect(screen.getByText('Loading users')).toBeTruthy();
    expect(screen.queryByText('No users found')).toBeNull();
  });
});
