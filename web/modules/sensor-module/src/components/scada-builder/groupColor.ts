/**
 * Single source for the group indicator color: a stable hue derived from
 * hashing the groupId. Previously duplicated in LayersPanel and
 * ScadaWidgetNode with slightly different hash loops — both now use this.
 */

export function groupColorFor(groupId: string | null | undefined): string | undefined {
  if (!groupId) return undefined;
  // Simple hash: sum char codes modulo 360 for hue
  let hash = 0;
  for (let i = 0; i < groupId.length; i++) {
    hash = (hash + groupId.charCodeAt(i) * 37) % 360;
  }
  return `hsl(${hash}, 70%, 55%)`;
}
