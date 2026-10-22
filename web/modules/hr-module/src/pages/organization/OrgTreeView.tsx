/**
 * OrgTreeView — the organization chart as nested lists.
 *
 * Plain `<ul>/<li>` nesting rather than an ARIA tree widget: screen readers
 * announce the depth natively, and every control is a real button or link, so
 * Tab / Enter / Space work with no key handling of our own. A department with
 * sub-departments has one toggle button (`aria-expanded`); all start expanded.
 */
import React, { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '@aquaculture/shared-ui';
import type { OrgNode } from './buildOrgTree';
import { OrgNodeCard } from './OrgNodeCard';

function OrgTreeItem({ node }: { node: OrgNode }): React.ReactElement {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const childrenId = useId();
  const name = node.department.name;
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div className="flex items-start gap-2">
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? childrenId : undefined}
            aria-label={t(expanded ? 'hr.orgChart.collapse' : 'hr.orgChart.expand', { name })}
            onClick={() => setExpanded((open) => !open)}
            className="mt-4 shrink-0 rounded p-0.5 text-gray-700 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {expanded ? (
              <ChevronDown className="h-5 w-5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="w-6 shrink-0" aria-hidden="true" />
        )}
        <OrgNodeCard node={node} />
      </div>
      {hasChildren && expanded && (
        <ul
          id={childrenId}
          className="mt-3 ml-3 space-y-3 border-l border-gray-200 pl-4 dark:border-gray-700"
        >
          {node.children.map((child) => (
            <OrgTreeItem key={child.department.id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgTreeView({ roots }: { roots: readonly OrgNode[] }): React.ReactElement {
  const { t } = useI18n();
  return (
    <ul aria-label={t('hr.orgChart.title')} className="space-y-3">
      {roots.map((root) => (
        <OrgTreeItem key={root.department.id} node={root} />
      ))}
    </ul>
  );
}
