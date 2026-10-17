import React from 'react';
import { consoleIconFor } from '@aquaculture/shared-ui';

export interface ModuleIconProps {
  /** The module record's lucide icon name (`auth.modules.icon`); null when it has none. */
  name: string | null;
  className?: string;
}

/**
 * ModuleIcon -- draws a module record's icon.
 *
 * WHAT: resolves the record's lucide name through the console icon
 * vocabulary (`consoleIconFor`) and draws that component, or the neutral
 * package glyph for a name outside it. Decorative: the module's name sits
 * beside it.
 *
 * WHY: a module record names its icon ("users", "sprout"); a list that put
 * the field on screen printed the name as text, and lists that kept their own
 * code-to-emoji maps disagreed with the record. Every module list draws
 * through this one component instead.
 */
const ModuleIcon: React.FC<ModuleIconProps> = ({ name, className }) => {
  const Icon = consoleIconFor(name);
  return <Icon className={className} aria-hidden="true" />;
};

export default ModuleIcon;
