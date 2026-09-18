/**
 * Projection spec for the task farm-AI responder (PR-5): PII deep ban, ISO
 * dates.
 */
import { projectTask } from '../projections';
import { Task } from '../../entities/task.entity';

const BANNED_KEYS = [
  'reportedBy',
  'assignedTo',
  'assignedToName',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklistItems',
  'description',
  'tenantId',
  'createdAt',
  'updatedAt',
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const TASK: Task = {
  id: 'task1',
  tenantId: 't',
  title: 'Check DO sensor',
  description: 'operator description',
  category: 'WATER_QUALITY',
  priority: 'HIGH',
  status: 'PENDING',
  assignedTo: 'user-id',
  assignedToName: 'Ayse Yilmaz',
  createdBy: 'user-id',
  dueDate: new Date('2026-09-18T00:00:00.000Z'),
  dueTime: '08:30:00',
  siteId: 's1',
  location: 'Cage row 2',
  estimatedMinutes: 30,
  checklistItems: [{ label: 'calibrate' }],
  notes: [{ body: 'operator note' }],
  tags: ['sensor'],
  isRecurring: true,
} as unknown as Task;

describe('task farm-AI projections (PR-5 read-only namespace)', () => {
  it('strips assignee/creator PII, notes and checklists — deep key scan', () => {
    const projection = projectTask(TASK);
    const keys = collectKeys(projection);
    for (const banned of BANNED_KEYS) {
      expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
    }
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('Ayse Yilmaz');
    expect(serialized).not.toContain('operator note');
    expect(serialized).not.toContain('calibrate');
  });

  it('serializes dates as ISO and keeps schedule fields', () => {
    const projection = projectTask(TASK);
    expect(projection.dueDate).toBe('2026-09-18T00:00:00.000Z');
    expect(projection.dueTime).toBe('08:30:00');
    expect(projection.priority).toBe('HIGH');
    expect(projection.tags).toEqual(['sensor']);
    expect(projection.isRecurring).toBe(true);
  });
});
