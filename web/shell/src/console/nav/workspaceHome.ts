/**
 * Where a workspace opens (design digest §10.3, `wsHome`): choosing a
 * workspace in the module menu navigates to its first page — area, then
 * group, then page order — of the nav the viewer was built, so the home is
 * always a page the viewer may open.
 */

/** The shape a built workspace and a definition share — what the home reads. */
export interface HomeableWorkspace {
  readonly areas: readonly {
    readonly groups: readonly { readonly pages: readonly { readonly path: string }[] }[];
  }[];
}

/** The first page's destination, or undefined for a workspace with no page. */
export function workspaceHome(workspace: HomeableWorkspace): string | undefined {
  for (const area of workspace.areas) {
    for (const group of area.groups) {
      const [first] = group.pages;
      if (first !== undefined) return first.path;
    }
  }
  return undefined;
}
