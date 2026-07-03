import { BaseEvent } from './base-event';

/**
 * Event emitted when a new task is created
 */
export interface TaskCreatedEvent extends BaseEvent {
  eventType: 'TaskCreated';
  taskId: string;
  title: string;
  category: string;
  priority: string;
  assignedTo: string;
  assignedToName: string;
  dueDate: string;
  createdBy: string;
}

/**
 * Event emitted when a task is assigned to a user
 */
export interface TaskAssignedEvent extends BaseEvent {
  eventType: 'TaskAssigned';
  taskId: string;
  title: string;
  assignedTo: string;
  assignedBy: string;
  dueDate: string;
  priority: string;
}

/**
 * Event emitted when a task's status changes
 */
export interface TaskStatusChangedEvent extends BaseEvent {
  eventType: 'TaskStatusChanged';
  taskId: string;
  previousStatus: string;
  newStatus: string;
  changedBy: string;
}

/**
 * Event emitted when a task is completed
 */
export interface TaskCompletedEvent extends BaseEvent {
  eventType: 'TaskCompleted';
  taskId: string;
  title: string;
  completedBy: string;
  completedAt: string;
  assignedTo: string;
}

/**
 * Event emitted when a task is overdue
 */
export interface TaskOverdueEvent extends BaseEvent {
  eventType: 'TaskOverdue';
  taskId: string;
  title: string;
  assignedTo: string;
  dueDate: string;
  priority: string;
  hoursOverdue: number;
}

export type TaskEvent =
  | TaskCreatedEvent
  | TaskAssignedEvent
  | TaskStatusChangedEvent
  | TaskCompletedEvent
  | TaskOverdueEvent;
