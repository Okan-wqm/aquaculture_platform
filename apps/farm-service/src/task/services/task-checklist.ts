/**
 * Task checklist normalisation — the one shape every stored and served
 * checklist item takes (FARM-HIGH-320).
 *
 * WHY a module of pure functions rather than statics on TaskService: the task
 * create path (TaskCreator) is reached by the AI createTask responder, and
 * code on that path may not depend on a service that holds repositories or a
 * DataSource (K10 layer 4). The resolvers, the recurring-task service and
 * TaskService use the same functions.
 */
import { randomUUID } from 'crypto';

import type { StoredTaskChecklistItem, TaskChecklistItem } from '../entities/task.entity';

/**
 * Normalise a single `checklistItems` entry so every stored item
 * carries (a) a server-assigned UUID `id` and (b) the canonical
 * `isCompleted` boolean flag.
 *
 * Two historical shapes are accepted on input:
 *   - UI/DTO shape: `{ text, isCompleted? }` — the `TaskChecklistItemInput`
 *     DTO's field set.
 *   - Legacy toggle shape: `{ completed, completedAt }` — produced
 *     by older `toggleChecklistItem` writes before the canonical
 *     field was unified.
 *
 * The return is always `{ id, text, isCompleted, completedAt?, completedBy? }`:
 * the `completed` field is dropped from future writes so there's a
 * single source of truth for UI reads. Existing rows with the
 * legacy field stay readable (TypeORM doesn't delete JSONB keys on
 * save — whatever we emit REPLACES the array entry, so the stale
 * `completed` is gone after the first normalise-and-save).
 */
export function normaliseChecklistItem(raw: Partial<StoredTaskChecklistItem>): TaskChecklistItem {
  const canonicalCompleted = raw.isCompleted ?? raw.completed ?? false;
  const normalised: TaskChecklistItem = {
    id: raw.id ?? randomUUID(),
    text: raw.text ?? '',
    isCompleted: canonicalCompleted,
  };
  if (raw.completedAt !== undefined) normalised.completedAt = raw.completedAt;
  if (raw.completedBy !== undefined) normalised.completedBy = raw.completedBy;
  return normalised;
}

/**
 * Public because it is ALSO the read path: the `checklistItems` field
 * resolvers on Task and RecurringTemplate serve every row through it, so the
 * wire never carries the permissive stored shape (FARM-HIGH-320).
 */
export function normaliseChecklistItems(
  raw: Partial<StoredTaskChecklistItem>[] | undefined,
): TaskChecklistItem[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => normaliseChecklistItem(item));
}

/**
 * Clone a template's checklist items into a fresh list suitable
 * for a new Task. Each propagated item gets a fresh UUID so
 * toggles on the spawned task don't collide with the template's
 * ids (or with sibling tasks spawned from the same template),
 * and the `isCompleted`/`completedAt`/`completedBy` audit fields
 * are reset — a brand-new task starts with everything unchecked.
 */
export function propagateChecklistItemsFromTemplate(
  templateItems: Partial<StoredTaskChecklistItem>[] | undefined,
): TaskChecklistItem[] {
  if (!templateItems || !Array.isArray(templateItems)) return [];
  return templateItems.map((t) => ({
    id: randomUUID(),
    text: t.text ?? '',
    isCompleted: false,
  }));
}
