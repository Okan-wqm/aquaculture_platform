/**
 * OrgNodeCard — one department on the organization chart: its name, code and
 * module, head count, manager, and a link to its people.
 *
 * The module comes from moduleLabels (never retyped); the people link is the
 * Team list's existing `?departmentId=` filter.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Building2, ChevronRight, UserRound, Users } from 'lucide-react';
import { useI18n } from '@aquaculture/shared-ui';
import { StatusBadge } from '../../components/common';
import { moduleLabel } from '../../utils/moduleLabels';
import type { OrgNode } from './buildOrgTree';
import { headCountLabel, managerLabel, rootReasonLabel } from './orgLabels';

interface OrgNodeCardProps {
  node: OrgNode;
}

export function OrgNodeCard({ node }: OrgNodeCardProps): React.ReactElement {
  const { t } = useI18n();
  const { department } = node;
  const rootNote = rootReasonLabel(node.rootReason, t);

  return (
    <div className="min-w-0 flex-1 rounded-xl border border-gray-100 bg-white p-4 shadow-(--shadow-sd-sm) dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <Building2
            className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 dark:text-white">{department.name}</p>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {department.code} · {moduleLabel(department.moduleCode, t)}
            </p>
          </div>
          {!department.isActive && (
            <StatusBadge label={t('hr.orgChart.inactive')} variant="default" size="sm" />
          )}
        </div>
        <Link
          to={`/hr/employees?departmentId=${department.id}`}
          aria-label={t('hr.orgChart.viewTeamOf', { name: department.name })}
          className="inline-flex items-center gap-1 rounded text-sm text-primary-700 hover:text-primary-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600 dark:text-primary-400 dark:hover:text-primary-300"
        >
          {t('hr.orgChart.viewTeam')}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
        <span className="inline-flex items-center gap-1.5">
          <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{headCountLabel(node, t)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <UserRound className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{managerLabel(node.manager, t)}</span>
        </span>
      </div>

      {rootNote && <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{rootNote}</p>}
    </div>
  );
}
