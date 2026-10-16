/**
 * The tenant console's token scope reaches its dialogs and dark islands
 * (suderra.css, FE-HIGH-321).
 *
 * Modal, ConfirmModal and Drawer portal to <body>, outside the shell's
 * `sd-content` column, so the column's scope cannot reach them by
 * inheritance: without the dialog form in the scope selector, every farm, hr
 * and sensor dialog opened from an Industry page painted in the legacy
 * palette (Ocean Blue, rounded, Inter). The dark rule must also meet a
 * surface that pins `data-theme="dark"` on itself, or that surface inherits
 * the light graphite ramp.
 *
 * jsdom cannot evaluate a complex selector inside `:where()`, so the spec
 * reads the scope's selector lists from suderra.css and matches each
 * alternative on its own (`:where(A, B)` matches what A or B matches).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ConfirmModal, Modal } from '../../components/Modal/Modal';
import { Drawer } from '../../components/Drawer/Drawer';

const DARK = "[data-theme='dark']";
const RULES = [
  ...readFileSync(resolve(__dirname, '../suderra.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map(([, selector = '', body = '']) => ({
  selector: selector.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim(),
  body,
}));

/** Splits a selector list at its top-level commas. */
function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  return [...parts, current.trim()];
}

function ruleDeclaring(declaration: string): string {
  const rule = RULES.find(({ body }) => body.includes(declaration));
  if (rule === undefined) throw new Error(`suderra.css declares no ${declaration}`);
  return rule.selector;
}

/** The light scope `:where(…)`'s alternatives — the rule that maps white to cream. */
const SCOPE = splitList(
  /^:where\((.*)\)$/.exec(ruleDeclaring('--color-white: var(--color-sd-cream);'))?.[1] ?? '',
);
const inScope = (element: Element): boolean => SCOPE.some((alt) => element.matches(alt));

/** The dark rule (the one mapping gray to the dark ramp), one test per selector form. */
const DARK_FORMS = splitList(ruleDeclaring('--color-gray-50: var(--color-sd-deep-50);')).map(
  (selector): ((element: Element) => boolean) => {
    const list = (pattern: RegExp): string[] => splitList(pattern.exec(selector)?.[1] ?? '');
    const anyOf = (alts: string[], element: Element): boolean =>
      alts.some((alt) => element.matches(alt));
    if (selector.startsWith(`${DARK} :where(`)) {
      const alts = list(/^\S+ :where\((.*)\)$/);
      return (element) => anyOf(alts, element) && element.parentElement?.closest(DARK) != null;
    }
    if (selector.startsWith(`${DARK}:where(`)) {
      const alts = list(/^\S+?:where\((.*)\)$/);
      return (element) => element.matches(DARK) && anyOf(alts, element);
    }
    if (selector.endsWith(` ${DARK}`)) {
      const alts = list(/^:where\((.*)\) \S+$/);
      return (element) => {
        let ancestor = element.parentElement;
        while (ancestor !== null && !anyOf(alts, ancestor)) ancestor = ancestor.parentElement;
        return element.matches(DARK) && ancestor !== null;
      };
    }
    throw new Error(`dark scope selector of an unknown form: ${selector}`);
  },
);
const inDarkScope = (element: Element): boolean => DARK_FORMS.some((form) => form(element));

const noop = (): void => undefined;
const dialogs: Array<[string, React.ReactElement]> = [
  [
    'Modal',
    <Modal key="m" isOpen onClose={noop} title="Batch">
      <p>body</p>
    </Modal>,
  ],
  [
    'ConfirmModal',
    <ConfirmModal key="c" isOpen onClose={noop} onConfirm={noop} title="Close" message="Sure?" />,
  ],
  [
    'Drawer',
    <Drawer key="d" isOpen onClose={noop} title="Pond">
      <p>body</p>
    </Drawer>,
  ],
];

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe('suderra.css — the console scope reaches portaled dialogs', () => {
  it('reads both selector lists', () => {
    expect(SCOPE).toContain('.sd-content');
    expect(DARK_FORMS).toHaveLength(3);
  });

  it.each(dialogs)('a %s opened from a console page joins the scope by its role', (_, dialog) => {
    render(<div className="sd-content">{dialog}</div>);
    const root = screen.getByRole('dialog');
    expect(root.closest('.sd-content')).toBeNull();
    expect(inScope(root)).toBe(true);
    expect(inDarkScope(root)).toBe(false);
  });

  it('outside the console a dialog keeps the default palette', () => {
    render(
      <Modal isOpen onClose={noop} title="Admin">
        <p>body</p>
      </Modal>,
    );
    expect(inScope(screen.getByRole('dialog'))).toBe(false);
  });

  it('takes the dark ramp under a dark page and when pinned dark on its own root', () => {
    document.documentElement.dataset.theme = 'dark';
    const { unmount } = render(
      <div className="sd-content">
        <Modal isOpen onClose={noop} title="Page">
          <p>x</p>
        </Modal>
      </div>,
    );
    expect(inDarkScope(screen.getByRole('dialog'))).toBe(true);
    unmount();
    delete document.documentElement.dataset.theme;
    render(
      <div className="sd-content">
        <Modal isOpen onClose={noop} theme="dark" title="Export">
          <p>x</p>
        </Modal>
      </div>,
    );
    expect(inDarkScope(screen.getByRole('dialog'))).toBe(true);
  });

  it('a dark island inside a console page takes the dark ramp', () => {
    render(
      <div className="sd-content">
        <div data-testid="island" data-theme="dark" />
        <div data-testid="light" />
      </div>,
    );
    expect(inDarkScope(screen.getByTestId('island'))).toBe(true);
    expect(inDarkScope(screen.getByTestId('light'))).toBe(false);
  });
});
