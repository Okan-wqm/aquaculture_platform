/**
 * Who is responsible for each level of the selected node's chain.
 *
 * WHY: responsibility is recorded per level by the records themselves — a
 * site's responsible people are its contacts (site_contacts, the primary one
 * first; the older free-text `siteManager` when no contact is set) and a
 * department's is its manager (departments.managerName / managerUserId). The
 * page reads those fields; it does not keep a second assignment table.
 *
 * WHAT: one row per site/department in the chain, with what is recorded (a
 * name, a manager user stored without a name, or nothing) and a load status,
 * so a failed or still-loading read is never reported as "not assigned".
 */
import { useSiteContacts, type SiteContact } from '../../../hooks/useSites';

import type { DepartmentNode, FacilityNode, SiteNode } from './facilityTree';

export type ResponsibilityStatus = 'loading' | 'error' | 'ready';

export type Responsible =
  /** A person recorded by name. */
  | { kind: 'named'; label: string }
  /**
   * A manager user is recorded but no display name was stored with it
   * (farm-service accepts managerId without managerName) — assigned, so not a
   * setup gap, but there is no name to show.
   */
  | { kind: 'unnamedUser' };

export interface ResponsibilityRow {
  node: SiteNode | DepartmentNode;
  status: ResponsibilityStatus;
  /** Null when the level records nobody; meaningful only when status is 'ready'. */
  responsible: Responsible | null;
}

function named(value: string | null | undefined): Responsible | null {
  const label = value?.trim();
  return label ? { kind: 'named', label } : null;
}

function siteResponsible(site: SiteNode, contacts: readonly SiteContact[]): Responsible | null {
  const primary = contacts.find((contact) => contact.isPrimary);
  if (primary) return named(primary.role ? `${primary.name} · ${primary.role}` : primary.name);
  return named(site.site.siteManager);
}

function departmentResponsible(department: DepartmentNode): Responsible | null {
  const { managerName, managerUserId } = department.department;
  return named(managerName) ?? (managerUserId ? { kind: 'unnamedUser' } : null);
}

export function useChainResponsibility(path: readonly FacilityNode[]): ResponsibilityRow[] {
  const site = path.find((node): node is SiteNode => node.kind === 'site');
  const contacts = useSiteContacts(site?.id);

  const rows: ResponsibilityRow[] = [];
  if (site) {
    // useTenantQuery keeps the previous key's data while a new key loads: after
    // switching sites that placeholder is the OTHER site's contact list, so it
    // counts as loading — never as this site's answer.
    const status: ResponsibilityStatus = contacts.isError
      ? 'error'
      : contacts.data && !contacts.isPlaceholderData
        ? 'ready'
        : 'loading';
    rows.push({
      node: site,
      status,
      responsible: status === 'ready' ? siteResponsible(site, contacts.data ?? []) : null,
    });
  }
  for (const node of path) {
    if (node.kind !== 'department') continue;
    // The department fields arrive with the departments list the tree is built
    // from, so a department row is ready whenever the tree is.
    rows.push({ node, status: 'ready', responsible: departmentResponsible(node) });
  }
  // TODO(data): systems have no responsible person and equipment inherits its
  // system's in the design — needs a responsible (user id) column on farm-service
  // System (and its GraphQL type) before a system row can be shown here.
  return rows;
}
