/**
 * CommandPalette (FE-HIGH-334, design README §8) — the dialog: a modal
 * combobox over grouped results, driven from the keyboard.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React, { useState } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from '../CommandPalette';
import type {
  PaletteCommandEntry,
  PaletteEntry,
  PaletteLinkEntry,
  PaletteSources,
} from '../CommandPaletteTypes';

const scrollIntoView = vi.fn();
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  // jsdom lays nothing out and has no scrollIntoView; the palette keeps the
  // active row in view with it.
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

function link(
  label: string,
  path: string,
  extra: Partial<PaletteLinkEntry> = {},
): PaletteLinkEntry {
  return { kind: 'link', id: path, label, path, ...extra };
}

const DARK_THEME: PaletteCommandEntry = {
  kind: 'command',
  id: 'theme',
  label: 'Switch to dark theme',
  command: { type: 'theme', theme: 'dark' },
};

const SOURCES: PaletteSources = {
  pages: [
    link('Dashboard', '/dashboard', { hint: 'Overview' }),
    link('Feeding', '/sites/feeding', { hint: 'Operations' }),
    link('Feed stock', '/sites/inventory?tab=feed', { hint: 'Operations' }),
    link('Alarms', '/sensor/alerts', { hint: 'Operations' }),
  ],
  people: {
    status: 'ready',
    entries: [link('Fehmi Kaya', '/hr/employees/7', { hint: 'Operator' })],
  },
  devices: { status: 'unavailable' },
  commands: [DARK_THEME],
};

interface HarnessProps {
  readonly sources?: PaletteSources;
  readonly onSelect?: (entry: PaletteEntry) => void;
  readonly onClose?: () => void;
}

/** The shell's side: the controlled query, and a trigger that opens the palette. */
function Harness({
  sources = SOURCES,
  onSelect = vi.fn(),
  onClose,
}: HarnessProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open palette
      </button>
      <CommandPalette
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        query={query}
        onQueryChange={setQuery}
        sources={sources}
        onSelect={onSelect}
      />
    </>
  );
}

async function openPalette(props: HarnessProps = {}): Promise<HTMLElement> {
  render(<Harness {...props} />);
  const trigger = screen.getByRole('button', { name: 'open palette' });
  trigger.focus();
  fireEvent.click(trigger);
  const input = screen.getByRole('combobox');
  await waitFor(() => expect(document.activeElement).toBe(input));
  return input;
}

function type(input: HTMLElement, text: string): void {
  fireEvent.change(input, { target: { value: text } });
}

/** The option the combobox names as active (aria-activedescendant), or null. */
function activeOption(input: HTMLElement): HTMLElement | null {
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
}

describe('CommandPalette — dialog', () => {
  it('renders nothing while closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens as a named modal dialog with the search field focused', async () => {
    const input = await openPalette();
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(input).toHaveAccessibleName('Type a page, person, device or command…');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
  });

  it('closes on Escape and gives focus back to what opened it', async () => {
    const onClose = vi.fn();
    const input = await openPalette({ onClose });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'open palette' }));
  });

  it('closes on a click on the backdrop, not on a click inside', async () => {
    const onClose = vi.fn();
    await openPalette({ onClose });
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    // The backdrop is the dialog's preceding sibling, outside it.
    const backdrop = screen.getByRole('dialog').previousElementSibling;
    if (!backdrop) throw new Error('the palette renders no backdrop');
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog', async () => {
    const input = await openPalette();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(input);
  });
});

describe('CommandPalette — results', () => {
  it('offers the commands, then the pages, before anything is typed', async () => {
    await openPalette();
    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAccessibleName('Commands');
    expect(groups[1]).toHaveAccessibleName('Pages');
    expect(within(groups[0]).getByRole('option', { name: /Switch to dark theme/ })).toBeTruthy();
    expect(within(groups[1]).getAllByRole('option')).toHaveLength(4);
  });

  it('filters and groups what the query matches, the hint with each row', async () => {
    const input = await openPalette();
    type(input, 'fe');
    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    expect(groups[0]).toHaveAccessibleName('Pages');
    expect(
      within(groups[0])
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining('Feeding'), expect.stringContaining('Feed stock')]);
    expect(within(groups[0]).getAllByRole('option')[0]).toHaveTextContent('Operations');
    expect(groups[1]).toHaveAccessibleName('People');
    expect(within(groups[1]).getByRole('option')).toHaveTextContent('Fehmi Kaya');
    expect(screen.getByRole('status')).toHaveTextContent('3 results');
  });

  it('says so when nothing matches', async () => {
    const input = await openPalette();
    type(input, 'zzz');
    expect(within(screen.getByRole('listbox')).queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('No results for “zzz”');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('says a fetched source is still loading or failed instead of showing no match', async () => {
    const input = await openPalette({
      sources: { ...SOURCES, people: { status: 'loading' }, devices: { status: 'error' } },
    });
    type(input, 'zzz');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Searching people…');
    expect(status).toHaveTextContent('Devices could not be loaded');
    expect(status).not.toHaveTextContent('No results');
  });

  it('draws 48px rows', async () => {
    await openPalette();
    for (const option of screen.getAllByRole('option')) expect(option).toHaveClass('min-h-12');
  });
});

describe('CommandPalette — keyboard and pointer', () => {
  it('starts on the first row and moves with the arrow keys, stopping at either end', async () => {
    const input = await openPalette();
    type(input, 'fe');
    const options = screen.getAllByRole('option');
    expect(activeOption(input)).toBe(options[0]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption(input)).toBe(options[0]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toBe(options[2]);
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toBe(options[2]);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption(input)).toBe(options[1]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('goes back to the first row when the query changes', async () => {
    const input = await openPalette();
    type(input, 'fe');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    type(input, 'fee');
    expect(activeOption(input)).toBe(screen.getAllByRole('option')[0]);
  });

  it('goes back to the first row on every edit, also when the query returns to an earlier one', async () => {
    const input = await openPalette();
    type(input, 'fe');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toBe(screen.getAllByRole('option')[2]);
    type(input, 'f');
    type(input, 'fe');
    expect(activeOption(input)).toBe(screen.getAllByRole('option')[0]);
  });

  it('keeps the highlight on its entry when a late source adds rows above it', async () => {
    const pump = link('Feeder pump', '/sensor/devices/edge/d1', { hint: 'Offline' });
    const late: PaletteSources = {
      ...SOURCES,
      people: { status: 'loading' },
      devices: { status: 'ready', entries: [pump] },
    };
    const { rerender } = render(<Harness sources={late} />);
    fireEvent.click(screen.getByRole('button', { name: 'open palette' }));
    const input = screen.getByRole('combobox');
    type(input, 'fe');
    // Feeding, Feed stock, then the device: the highlight moves onto the device.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toHaveTextContent('Feeder pump');

    // People answer: Fehmi Kaya lands above the device, the highlight stays on it.
    rerender(<Harness sources={{ ...late, people: SOURCES.people }} />);
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Feeding'),
      expect.stringContaining('Feed stock'),
      expect.stringContaining('Fehmi Kaya'),
      expect.stringContaining('Feeder pump'),
    ]);
    expect(activeOption(input)).toBe(options[3]);
    expect(options[3]).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to the first row when the highlighted entry drops out', async () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'open palette' }));
    const input = screen.getByRole('combobox');
    type(input, 'fe');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toHaveTextContent('Fehmi Kaya');

    // The people search fails on a refetch: Fehmi Kaya is no longer listed.
    rerender(<Harness sources={{ ...SOURCES, people: { status: 'error' } }} />);
    expect(screen.queryByRole('option', { name: /Fehmi Kaya/ })).toBeNull();
    expect(activeOption(input)).toBe(screen.getAllByRole('option')[0]);
  });

  it('runs the highlighted row on Enter and closes', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const input = await openPalette({ onSelect, onClose });
    type(input, 'fe');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(SOURCES.pages[2]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('runs a command entry the same way', async () => {
    const onSelect = vi.fn();
    const input = await openPalette({ onSelect });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(DARK_THEME);
  });

  it('does nothing on Enter when nothing matches, or while an IME is composing', async () => {
    const onSelect = vi.fn();
    const input = await openPalette({ onSelect });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    type(input, 'zzz');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('highlights the row under the pointer and runs the row clicked', async () => {
    const onSelect = vi.fn();
    const input = await openPalette({ onSelect });
    type(input, 'fe');
    const options = screen.getAllByRole('option');
    fireEvent.mouseMove(options[2]);
    expect(activeOption(input)).toBe(options[2]);
    fireEvent.click(options[1]);
    expect(onSelect).toHaveBeenCalledWith(SOURCES.pages[2]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
