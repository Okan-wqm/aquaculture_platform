/**
 * The console rail's icon vocabulary (design handoff §8.2, §11).
 *
 * WHAT: Lucide's kebab-case names for the area icons, mapped to their
 * components. A nav area names its icon by key, so the nav model stays plain
 * data (the shell's coverage invariant imports it without React).
 *
 * WHY the rail owns the list: the rail is what has to draw the icon, so the
 * shell's `ConsoleIcon` is this file's key union — a nav area cannot name an
 * icon the rail has no component for.
 */
import {
  Activity,
  Building2,
  ClipboardCheck,
  Cpu,
  CreditCard,
  FileText,
  Fish,
  Gauge,
  ShieldCheck,
  SlidersHorizontal,
  Sprout,
  Users,
  type LucideIcon,
} from 'lucide-react';

export const CONSOLE_RAIL_ICONS = {
  gauge: Gauge,
  fish: Fish,
  sprout: Sprout,
  activity: Activity,
  users: Users,
  'clipboard-check': ClipboardCheck,
  'credit-card': CreditCard,
  'building-2': Building2,
  'file-text': FileText,
  cpu: Cpu,
  'shield-check': ShieldCheck,
  'sliders-horizontal': SlidersHorizontal,
} as const satisfies Record<string, LucideIcon>;

export type ConsoleRailIconName = keyof typeof CONSOLE_RAIL_ICONS;
