/**
 * TaskService.normaliseChecklistItem + propagateChecklistItemsFromTemplate
 *
 * Unit tests for the checklist-item normalisation logic that closes
 * two latent bugs discovered during the type-safety audit:
 *
 *   1. Checklist items created via the `TaskChecklistItemInput` DTO
 *      had no `id` field — every call to `toggleChecklistItem(itemId)`
 *      silently failed the `find((i) => i.id === itemId)` lookup.
 *
 *   2. The toggle path wrote `item.completed` while the input path
 *      wrote `item.isCompleted`. A UI reading `isCompleted` after a
 *      toggle would see no change because the toggle wrote a
 *      different field.
 *
 * The normaliser unifies both into canonical `{ id, text,
 * isCompleted, completedAt?, completedBy? }` shape and is applied
 * at every write entry point (create / update / toggle /
 * propagateFromTemplate).
 */
import { TaskService } from '../task.service';
import type { StoredTaskChecklistItem, TaskChecklistItem } from '../../entities/task.entity';

describe('TaskService.normaliseChecklistItem', () => {
  it('assigns a fresh UUID when the input item has no id', () => {
    const out = TaskService.normaliseChecklistItem({ text: 'feed the tank' });
    expect(out.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(out.text).toBe('feed the tank');
    // isCompleted defaults to false, canonical field.
    expect(out.isCompleted).toBe(false);
  });

  it('preserves a provided id on the input (round-trip stable)', () => {
    const out = TaskService.normaliseChecklistItem({
      id: '11111111-1111-4111-8111-111111111111',
      text: 'x',
    });
    expect(out.id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('maps legacy `completed` field onto canonical `isCompleted`', () => {
    // Legacy toggle-written shape.
    const out = TaskService.normaliseChecklistItem({
      id: 'item-1',
      text: 'legacy',
      completed: true,
      completedAt: '2026-04-01T00:00:00Z',
    } as Partial<StoredTaskChecklistItem>);
    expect(out.isCompleted).toBe(true);
    // The legacy `completed` field is NOT re-emitted — the canonical
    // shape is `isCompleted` only.
    // The canonical TaskChecklistItem has no `completed` member at all
    // (FARM-HIGH-301): the legacy flag cannot be re-emitted, only read.
    expect(out).not.toHaveProperty('completed');
    expect(out.completedAt).toBe('2026-04-01T00:00:00Z');
  });

  it('prefers `isCompleted` when both legacy and canonical are set', () => {
    // Edge case: a half-migrated row carrying both fields. Canonical
    // wins.
    const out = TaskService.normaliseChecklistItem({
      id: 'item-1',
      text: 't',
      isCompleted: false,
      completed: true,
    } as Partial<StoredTaskChecklistItem>);
    expect(out.isCompleted).toBe(false);
  });

  it('defaults text to empty string when the input omits it', () => {
    const out = TaskService.normaliseChecklistItem({});
    expect(out.text).toBe('');
  });

  it('preserves completedBy when present', () => {
    const out = TaskService.normaliseChecklistItem({
      text: 't',
      isCompleted: true,
      completedBy: 'user-7',
    });
    expect(out.completedBy).toBe('user-7');
  });
});

describe('TaskService.propagateChecklistItemsFromTemplate', () => {
  it('clones template items with FRESH uuids (no id collision)', () => {
    const template: Partial<TaskChecklistItem>[] = [
      { id: 'tpl-1', text: 'check oxygen', isCompleted: true },
      { id: 'tpl-2', text: 'record readings', isCompleted: false },
    ];

    const cloned = TaskService.propagateChecklistItemsFromTemplate(template);

    expect(cloned).toHaveLength(2);
    expect(cloned[0]!.id).not.toBe('tpl-1');
    expect(cloned[1]!.id).not.toBe('tpl-2');
    expect(cloned[0]!.id).not.toBe(cloned[1]!.id);
    // Fresh task starts with every item unchecked — even template
    // items that were marked isCompleted in the template.
    expect(cloned[0]!.isCompleted).toBe(false);
    expect(cloned[1]!.isCompleted).toBe(false);
    // Texts carry through.
    expect(cloned[0]!.text).toBe('check oxygen');
    expect(cloned[1]!.text).toBe('record readings');
  });

  it('returns empty array when the template has no items', () => {
    expect(TaskService.propagateChecklistItemsFromTemplate(undefined)).toEqual([]);
    expect(TaskService.propagateChecklistItemsFromTemplate([])).toEqual([]);
  });

  it('two propagations from the same template produce non-colliding ids', () => {
    const template: Partial<TaskChecklistItem>[] = [{ text: 'x' }];
    const a = TaskService.propagateChecklistItemsFromTemplate(template);
    const b = TaskService.propagateChecklistItemsFromTemplate(template);
    expect(a[0]!.id).not.toBe(b[0]!.id);
  });
});
