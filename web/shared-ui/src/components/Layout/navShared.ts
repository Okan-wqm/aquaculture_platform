/**
 * Navigation behaviour shared by the two side navigations — `Sidebar` (the
 * SUPER_ADMIN column and standalone layouts) and `SuderraSidebar` (the tenant
 * console rail). They differ in presentation only; who may see an item, when
 * an item is the current page, and how the phone overlay opens and closes are
 * decided here once, so the two cannot drift apart (FE-HIGH-313).
 */
import { useCallback, useEffect, type RefObject } from 'react';

import type { NavigationItem, UserRole } from '../../types';
import { useDialogBehavior } from '../Modal/useDialogBehavior';

/** Tailwind's `md`: above it the navigation is an in-flow column, below it an off-canvas overlay. */
export const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

/** An item with no `requiredRoles` is visible to everyone; otherwise one matching role suffices. */
export function canSeeNavItem(item: NavigationItem, userRoles: readonly UserRole[]): boolean {
  return !item.requiredRoles?.length || item.requiredRoles.some((role) => userRoles.includes(role));
}

/**
 * The item is the current page: its own path, or — for a group — any path
 * below it. A leaf matches exactly, so `/tenant` does not light up on
 * `/tenant/users`.
 */
export function isNavItemActive(item: NavigationItem, activePath: string | undefined): boolean {
  if (!item.path || !activePath) return false;
  if (item.path === activePath) return true;
  return !!item.children?.length && activePath.startsWith(`${item.path}/`);
}

/** One of the group's children is the current page. */
export function hasActiveChild(item: NavigationItem, activePath: string | undefined): boolean {
  return !!activePath && !!item.children?.some((child) => child.path === activePath);
}

export interface NavOverlayOptions {
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
  containerRef: RefObject<HTMLElement | null>;
}

export interface NavOverlay {
  closeOverlay: () => void;
  /** Navigate, then close the overlay if it is open; the in-flow column stays put. */
  handleNavigate: (path: string) => void;
}

/**
 * The phone overlay: Escape, focus into the panel and back to the opener, and
 * the body scroll lock come from the hook Modal and Drawer share; the overlay
 * closes itself when the viewport grows past `md` (the in-flow column is on
 * screen again) and when a destination is chosen.
 */
export function useNavOverlay({
  mobileOpen,
  onMobileOpenChange,
  onNavigate,
  containerRef,
}: NavOverlayOptions): NavOverlay {
  const closeOverlay = useCallback(() => onMobileOpenChange(false), [onMobileOpenChange]);

  useDialogBehavior({
    isOpen: mobileOpen,
    onClose: closeOverlay,
    closeOnEscape: true,
    containerRef,
  });

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const desktop = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const settle = (): void => {
      if (desktop.matches) closeOverlay();
    };
    settle();
    desktop.addEventListener('change', settle);
    return () => desktop.removeEventListener('change', settle);
  }, [mobileOpen, closeOverlay]);

  const handleNavigate = useCallback(
    (path: string) => {
      onNavigate(path);
      if (mobileOpen) closeOverlay();
    },
    [onNavigate, mobileOpen, closeOverlay],
  );

  return { closeOverlay, handleNavigate };
}
