/**
 * The one nav-icon table. Both chrome components resolve from it: the legacy
 * `Sidebar` and the SUDERRA tenant-console rail `SuderraSidebar`.
 *
 * WHY a table of COMPONENTS rather than of rendered nodes: `Sidebar` draws its
 * icons at `w-5 h-5`, the rail at 18px for a parent and 15px for a child, with
 * its own active/child classes. A table of pre-rendered `<Icon className="w-5
 * h-5" />` nodes — which is what `Sidebar` carried alone — cannot serve a
 * second consumer at a different size without being copied, and the copy is how
 * the rail arrived: 42 names × 4 hand-transcribed SVG `d` strings, a second
 * icon vocabulary that drifts from this one silently and that the
 * `inlineIconSvg` ratchet (FE-MEDIUM-082) exists to keep out of `web/`.
 *
 * So the table holds the component and each consumer sizes it. Adding an icon
 * is one line here and both sidebars can use it.
 *
 * `NAV_ICON_ALIASES` maps the names live nav data already uses onto the table,
 * so neither consumer needs its nav trees rewritten to adopt the other's
 * vocabulary. An alias must resolve to a real key — enforced by
 * `tests/invariants/nav-icon-registry.spec.ts`.
 *
 * Four names existed in both tables with DIFFERENT icons: `alert` (Bell vs
 * TriangleAlert), `analytics` (ChartColumn vs ChartLine), `system` (Settings vs
 * SlidersVertical) and `messages` (MessageCircle vs MessagesSquare). Unifying
 * means picking one each, and the pick is `Sidebar`'s, because that is what
 * ships on main and every live nav tree was authored against it — adopting the
 * rail's would have silently redrawn four icons across the admin panel as a
 * side effect of adding a component. The rail's alternatives stay reachable
 * under their own canonical names (`triangle-alert`, `linechart`, `sliders`,
 * `comms`), so a nav tree that wants one asks for it.
 */
import {
  Activity,
  Banknote,
  Bell,
  Blocks,
  Building2,
  Calendar,
  ChartColumn,
  ChartLine,
  ClipboardList,
  Clock,
  Contact,
  Cpu,
  CreditCard,
  Database,
  Droplets,
  FileChartColumn,
  Gauge,
  HardDrive,
  House,
  LayoutTemplate,
  LifeBuoy,
  Mail,
  Map,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Maximize2,
  Network,
  RadioTower,
  Repeat2,
  Scroll,
  Settings,
  ShieldCheck,
  ShoppingBasket,
  SlidersVertical,
  Sprout,
  SquareCheckBig,
  TestTube,
  Thermometer,
  TriangleAlert,
  User,
  Users,
  Warehouse,
  Waves,
  Wheat,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * The width at which a nav stops being an overlay and becomes an in-flow
 * column. Shared by `Sidebar` and `SuderraSidebar` because two copies of one
 * breakpoint drift apart at exactly the width where the difference shows.
 */
export const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

/** Canonical icon name → the lucide component that draws it. */
export const NAV_ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  admin: Settings,
  alert: Bell,
  audit: ClipboardList,
  banknote: Banknote,
  bars: ChartColumn,
  basket: ShoppingBasket,
  bell: Bell,
  'triangle-alert': TriangleAlert,
  billing: CreditCard,
  blocks: Blocks,
  building: Building2,
  calendar: Calendar,
  card: CreditCard,
  chat: MessageCircle,
  checks: SquareCheckBig,
  chip: Cpu,
  clipboard: ClipboardList,
  clock: Clock,
  comms: MessagesSquare,
  messages: MessageCircle,
  contact: Contact,
  cpu: Cpu,
  dashboard: House,
  database: Database,
  drive: HardDrive,
  droplet: Droplets,
  expand: Maximize2,
  farm: Building2,
  gauge: Gauge,
  grid: LayoutTemplate,
  lifebuoy: LifeBuoy,
  analytics: ChartColumn,
  linechart: ChartLine,
  mail: Mail,
  map: Map,
  megaphone: Megaphone,
  modules: LayoutTemplate,
  network: Network,
  ph: TestTube,
  process: LayoutTemplate,
  pulse: Activity,
  report: FileChartColumn,
  repeat2: Repeat2,
  scroll: Scroll,
  sensor: ChartColumn,
  settings: SlidersVertical,
  shield: ShieldCheck,
  signal: RadioTower,
  sliders: SlidersVertical,
  system: Settings,
  sprout: Sprout,
  thermo: Thermometer,
  user: User,
  users: Users,
  warehouse: Warehouse,
  waves: Waves,
  wheat: Wheat,
  workflow: Workflow,
  wrench: Wrench,
};

/**
 * Names live nav data uses that are not table keys. Kept separate from
 * `NAV_ICONS` so the table stays a vocabulary and this stays a compatibility
 * map — merging them would hide which names are canonical.
 */
export const NAV_ICON_ALIASES: Record<string, string> = {
  'bar-chart': 'bars',
  'calendar-off': 'calendar',
  'graduation-cap': 'contact',
  message: 'chat',
  monitor: 'expand',
  reports: 'report',
  security: 'shield',
  server: 'chip',
  support: 'lifebuoy',
  tenants: 'building',
};

/**
 * Resolves an `item.icon` name to its component, following one alias hop.
 * Returns `null` for an unknown name so a consumer renders no icon rather than
 * a broken one.
 */
export function resolveNavIcon(name: string | undefined): LucideIcon | null {
  if (!name) return null;
  const direct = NAV_ICONS[name];
  if (direct) return direct;
  const aliased = NAV_ICON_ALIASES[name];
  return aliased ? (NAV_ICONS[aliased] ?? null) : null;
}
