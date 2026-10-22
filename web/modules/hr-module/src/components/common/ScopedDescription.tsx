/**
 * ScopedDescription — the description line of a module-scoped HR page: the page's own text and,
 * beside it, whose people the page is showing. One component, so no page repeats this wrapper.
 */
import React from 'react';
import { ModuleScopeBadge } from './ModuleScopeBadge';

interface ScopedDescriptionProps {
  text: string;
}

export function ScopedDescription({ text }: ScopedDescriptionProps): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-2">
      {text}
      <ModuleScopeBadge />
    </span>
  );
}

export default ScopedDescription;
