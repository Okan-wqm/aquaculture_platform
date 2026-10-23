/**
 * orgLabels — the words the organization chart uses for a node's facts.
 *
 * Kept apart from the components so each sentence is spelled once (in the locale
 * files) and can be read and tested without rendering anything. Every function
 * takes the translator, so the chart speaks the reader's language.
 */
import type { Translate } from '../../utils/moduleLabels';
import type { OrgManager, OrgNode, OrgRootReason } from './buildOrgTree';

export function peopleLabel(count: number, t: Translate): string {
  return count === 1 ? t('hr.orgChart.person.one') : t('hr.orgChart.person.other', { count });
}

/** The department's own head count, plus the subtree's when it has sub-departments. */
export function headCountLabel(node: OrgNode, t: Translate): string {
  const own = peopleLabel(node.directHeadCount, t);
  return node.children.length > 0
    ? t('hr.orgChart.headCountWithChildren', { own, total: node.totalHeadCount })
    : own;
}

export function managerLabel(manager: OrgManager | null, t: Translate): string {
  if (!manager) return t('hr.orgChart.noManager');
  return manager.name
    ? t('hr.orgChart.manager', { name: manager.name })
    : t('hr.orgChart.managerUnknown');
}

/** Why a node stands at the top of the chart; null when it is just a top-level department. */
export function rootReasonLabel(reason: OrgRootReason | null, t: Translate): string | null {
  switch (reason) {
    case 'parent-outside-view':
      return t('hr.orgChart.rootParentOutside');
    case 'cycle':
      return t('hr.orgChart.rootCycle');
    case 'top-level':
    case null:
      return null;
  }
}

/** How many departments the chart shows, for the page header. */
export function departmentCountLabel(count: number, t: Translate): string {
  return count === 1
    ? t('hr.orgChart.description.one')
    : t('hr.orgChart.description.other', { count });
}

export function unplacedLabel(count: number, t: Translate): string {
  return count === 1 ? t('hr.orgChart.unplaced.one') : t('hr.orgChart.unplaced.other', { count });
}
