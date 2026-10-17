/**
 * The console's icon vocabulary (design handoff §8.2, §11).
 *
 * WHAT: Lucide's kebab-case names for the console icons, mapped to their
 * components. A nav area names its icon by key, so the nav model stays plain
 * data (the shell's coverage invariant imports it without React). A module
 * record names its icon the same way (`auth.modules.icon`: fish, users,
 * activity, sprout, bell, brain), so the module lists draw through this map
 * too.
 *
 * WHY one map: the rail is what has to draw an area's icon, so the shell's
 * `ConsoleIcon` is this file's key union — a nav area cannot name an icon the
 * rail has no component for. A module record's icon is a runtime string, so
 * `consoleIconFor` is its one way in: a name inside the vocabulary draws its
 * component, any other name draws the neutral `CONSOLE_ICON_FALLBACK`. No list
 * keeps a map of its own, and none puts the name itself on screen.
 */
import {
  Activity,
  Bell,
  Brain,
  Building2,
  ClipboardCheck,
  Cpu,
  CreditCard,
  FileText,
  Fish,
  Gauge,
  Package,
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
  bell: Bell,
  brain: Brain,
  'clipboard-check': ClipboardCheck,
  'credit-card': CreditCard,
  'building-2': Building2,
  'file-text': FileText,
  cpu: Cpu,
  'shield-check': ShieldCheck,
  'sliders-horizontal': SlidersHorizontal,
} as const satisfies Record<string, LucideIcon>;

export type ConsoleRailIconName = keyof typeof CONSOLE_RAIL_ICONS;

/** The glyph for a name outside the vocabulary: a plain package, never the name as text. */
export const CONSOLE_ICON_FALLBACK: LucideIcon = Package;

/**
 * Whether a runtime string is a vocabulary key. An own-key check, so a name
 * off the object prototype (`constructor`, `__proto__`) is not one.
 */
function isConsoleRailIconName(name: string): name is ConsoleRailIconName {
  return Object.prototype.hasOwnProperty.call(CONSOLE_RAIL_ICONS, name);
}

/**
 * The component that draws a stored icon name (a module record's `icon`,
 * nullable in `auth.modules`): its vocabulary component, else the fallback.
 */
export function consoleIconFor(name: string | null): LucideIcon {
  return name !== null && isConsoleRailIconName(name)
    ? CONSOLE_RAIL_ICONS[name]
    : CONSOLE_ICON_FALLBACK;
}
