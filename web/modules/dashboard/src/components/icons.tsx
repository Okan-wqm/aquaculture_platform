/**
 * Dashboard Module Icons
 *
 * PERF-L4: Centralised SVG icon components — eliminates duplicate inline SVG
 * bytes that were repeated across DashboardPage, RecentActivityList,
 * AlertsSummary, QuickActions, AlertSummaryWidget, and WaterQualityGauge.
 *
 * Each icon is a small, pure functional component that accepts a `className`
 * prop so callers control size and colour via Tailwind utilities.
 */

import React from 'react';
import {
  Bell as BellLucideIcon,
  Clipboard as ClipboardIcon,
  Cpu,
  Download as DownloadLucideIcon,
  House as HouseIcon,
  Plus as PlusLucideIcon,
  Settings as SettingsLucideIcon,
  TrendingUp,
  User,
} from 'lucide-react';

interface IconProps {
  className?: string;
}

/** Chip / sensor icon (CPU outline) */
export const SensorIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
  <Cpu className={className} aria-hidden="true" />
);

/** Bell / notification alert icon */
export const BellIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
  <BellLucideIcon className={className} aria-hidden="true" />
);

/** Single user / person icon */
export const UserIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
  <User className={className} aria-hidden="true" />
);

/** Plus / add icon */
export const PlusIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
  <PlusLucideIcon className={className} aria-hidden="true" />
);

/** Download / export icon */
export const DownloadIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
  <DownloadLucideIcon className={className} aria-hidden="true" />
);

/** Trend-up / production chart icon */
export const TrendUpIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
  <TrendingUp className={className} aria-hidden="true" />
);

/** House / farm icon */
export const FarmIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
  <HouseIcon className={className} aria-hidden="true" />
);

/** Clipboard / task icon */
export const TaskIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
  <ClipboardIcon className={className} aria-hidden="true" />
);

/** Settings / cog icon */
export const SettingsIcon: React.FC<IconProps> = ({ className = 'w-5 h-5' }) => (
  <SettingsLucideIcon className={className} aria-hidden="true" />
);
