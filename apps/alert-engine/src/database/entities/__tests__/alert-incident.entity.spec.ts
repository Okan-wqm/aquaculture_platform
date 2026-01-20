import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
  IncidentTimelineEvent,
} from '../alert-incident.entity';
import { AlertSeverity } from '../alert-rule.entity';

describe('AlertIncident Entity', () => {
  const createIncident = (overrides?: Partial<AlertIncident>): AlertIncident => {
    const incident = new AlertIncident();
    incident.id = 'incident-1';
    incident.tenantId = 'tenant-1';
    incident.ruleId = 'rule-1';
    incident.title = 'Test Incident';
    incident.description = 'Test description';
    incident.severity = AlertSeverity.HIGH;
    incident.status = IncidentStatus.NEW;
    incident.riskScore = 75;
    incident.triggerData = { value: 35, threshold: 30 };
    incident.timeline = [];
    incident.relatedIncidentIds = [];
    incident.escalationLevel = 0;
    incident.occurrenceCount = 1;
    incident.createdAt = new Date();
    incident.updatedAt = new Date();

    if (overrides) {
      Object.assign(incident, overrides);
    }

    return incident;
  };

  describe('status checks', () => {
    describe('isOpen', () => {
      it('should return true for NEW status', () => {
        const incident = createIncident({ status: IncidentStatus.NEW });
        expect(incident.isOpen()).toBe(true);
      });

      it('should return true for ACKNOWLEDGED status', () => {
        const incident = createIncident({ status: IncidentStatus.ACKNOWLEDGED });
        expect(incident.isOpen()).toBe(true);
      });

      it('should return true for INVESTIGATING status', () => {
        const incident = createIncident({ status: IncidentStatus.INVESTIGATING });
        expect(incident.isOpen()).toBe(true);
      });

      it('should return false for RESOLVED status', () => {
        const incident = createIncident({ status: IncidentStatus.RESOLVED });
        expect(incident.isOpen()).toBe(false);
      });

      it('should return false for CLOSED status', () => {
        const incident = createIncident({ status: IncidentStatus.CLOSED });
        expect(incident.isOpen()).toBe(false);
      });

      it('should return false for SUPPRESSED status', () => {
        const incident = createIncident({ status: IncidentStatus.SUPPRESSED });
        expect(incident.isOpen()).toBe(false);
      });
    });

    describe('isClosed', () => {
      it('should return true for RESOLVED status', () => {
        const incident = createIncident({ status: IncidentStatus.RESOLVED });
        expect(incident.isClosed()).toBe(true);
      });

      it('should return true for CLOSED status', () => {
        const incident = createIncident({ status: IncidentStatus.CLOSED });
        expect(incident.isClosed()).toBe(true);
      });

      it('should return true for SUPPRESSED status', () => {
        const incident = createIncident({ status: IncidentStatus.SUPPRESSED });
        expect(incident.isClosed()).toBe(true);
      });

      it('should return false for NEW status', () => {
        const incident = createIncident({ status: IncidentStatus.NEW });
        expect(incident.isClosed()).toBe(false);
      });

      it('should return false for ACKNOWLEDGED status', () => {
        const incident = createIncident({ status: IncidentStatus.ACKNOWLEDGED });
        expect(incident.isClosed()).toBe(false);
      });
    });

    describe('canEscalate', () => {
      it('should return true for NEW status', () => {
        const incident = createIncident({ status: IncidentStatus.NEW });
        expect(incident.canEscalate()).toBe(true);
      });

      it('should return true for ACKNOWLEDGED status', () => {
        const incident = createIncident({ status: IncidentStatus.ACKNOWLEDGED });
        expect(incident.canEscalate()).toBe(true);
      });

      it('should return true for INVESTIGATING status', () => {
        const incident = createIncident({ status: IncidentStatus.INVESTIGATING });
        expect(incident.canEscalate()).toBe(true);
      });

      it('should return false for RESOLVED status', () => {
        const incident = createIncident({ status: IncidentStatus.RESOLVED });
        expect(incident.canEscalate()).toBe(false);
      });

      it('should return false for SUPPRESSED status', () => {
        const incident = createIncident({ status: IncidentStatus.SUPPRESSED });
        expect(incident.canEscalate()).toBe(false);
      });
    });
  });

  describe('lifecycle methods', () => {
    describe('acknowledge', () => {
      it('should acknowledge an open incident', () => {
        const incident = createIncident({ status: IncidentStatus.NEW });

        incident.acknowledge('user-1', 'Acknowledged the issue');

        expect(incident.status).toBe(IncidentStatus.ACKNOWLEDGED);
        expect(incident.acknowledgedBy).toBe('user-1');
        expect(incident.acknowledgedAt).toBeInstanceOf(Date);
      });

      it('should add timeline event on acknowledge', () => {
        const incident = createIncident({ status: IncidentStatus.NEW });

        incident.acknowledge('user-1');

        expect(incident.timeline).toHaveLength(1);
        expect(incident.timeline[0].type).toBe(TimelineEventType.ACKNOWLEDGED);
        expect(incident.timeline[0].userId).toBe('user-1');
      });

      it('should throw error when acknowledging closed incident', () => {
        const incident = createIncident({ status: IncidentStatus.RESOLVED });

        expect(() => incident.acknowledge('user-1')).toThrow('Cannot acknowledge a closed incident');
      });
    });

    describe('assign', () => {
      it('should assign incident to user', () => {
        const incident = createIncident();

        incident.assign('user-2', 'user-1');

        expect(incident.assignedTo).toBe('user-2');
      });

      it('should add timeline event on assign', () => {
        const incident = createIncident();

        incident.assign('user-2');

        expect(incident.timeline).toHaveLength(1);
        expect(incident.timeline[0].type).toBe(TimelineEventType.ASSIGNED);
        expect(incident.timeline[0].description).toContain('user-2');
      });
    });

    describe('startInvestigation', () => {
      it('should change status to INVESTIGATING', () => {
        const incident = createIncident({ status: IncidentStatus.ACKNOWLEDGED });

        incident.startInvestigation('user-1');

        expect(incident.status).toBe(IncidentStatus.INVESTIGATING);
      });

      it('should throw error for closed incident', () => {
        const incident = createIncident({ status: IncidentStatus.RESOLVED });

        expect(() => incident.startInvestigation('user-1')).toThrow('Cannot start investigation on a closed incident');
      });
    });

    describe('resolve', () => {
      it('should resolve an open incident', () => {
        const incident = createIncident({ status: IncidentStatus.INVESTIGATING });

        incident.resolve('user-1', 'Fixed the issue');

        expect(incident.status).toBe(IncidentStatus.RESOLVED);
        expect(incident.resolvedBy).toBe('user-1');
        expect(incident.resolvedAt).toBeInstanceOf(Date);
        expect(incident.resolutionNotes).toBe('Fixed the issue');
      });

      it('should add timeline event on resolve', () => {
        const incident = createIncident({ status: IncidentStatus.NEW });

        incident.resolve('user-1', 'Issue resolved');

        expect(incident.timeline).toHaveLength(1);
        expect(incident.timeline[0].type).toBe(TimelineEventType.RESOLVED);
      });

      it('should throw error when resolving already closed incident', () => {
        const incident = createIncident({ status: IncidentStatus.CLOSED });

        expect(() => incident.resolve('user-1')).toThrow('Incident is already closed');
      });
    });

    describe('close', () => {
      it('should close a resolved incident', () => {
        const incident = createIncident({ status: IncidentStatus.RESOLVED });

        incident.close('user-1');

        expect(incident.status).toBe(IncidentStatus.CLOSED);
      });

      it('should throw error when closing non-resolved incident', () => {
        const incident = createIncident({ status: IncidentStatus.NEW });

        expect(() => incident.close('user-1')).toThrow('Can only close resolved incidents');
      });
    });

    describe('reopen', () => {
      it('should reopen a closed incident', () => {
        const incident = createIncident({
          status: IncidentStatus.RESOLVED,
          resolvedBy: 'user-1',
          resolvedAt: new Date(),
          resolutionNotes: 'Fixed',
        });

        incident.reopen('user-2', 'Issue recurred');

        expect(incident.status).toBe(IncidentStatus.NEW);
        expect(incident.resolvedBy).toBeUndefined();
        expect(incident.resolvedAt).toBeUndefined();
        expect(incident.resolutionNotes).toBeUndefined();
      });

      it('should add timeline event on reopen', () => {
        const incident = createIncident({ status: IncidentStatus.RESOLVED });

        incident.reopen('user-1', 'Issue came back');

        expect(incident.timeline).toHaveLength(1);
        expect(incident.timeline[0].type).toBe(TimelineEventType.REOPENED);
      });

      it('should throw error when reopening open incident', () => {
        const incident = createIncident({ status: IncidentStatus.NEW });

        expect(() => incident.reopen('user-1')).toThrow('Can only reopen closed incidents');
      });
    });

    describe('suppress', () => {
      it('should suppress incident', () => {
        const incident = createIncident({ status: IncidentStatus.NEW });

        incident.suppress('user-1', 'False positive');

        expect(incident.status).toBe(IncidentStatus.SUPPRESSED);
      });

      it('should add timeline event on suppress', () => {
        const incident = createIncident();

        incident.suppress('user-1', 'Not relevant');

        expect(incident.timeline).toHaveLength(1);
        expect(incident.timeline[0].type).toBe(TimelineEventType.STATUS_CHANGE);
      });
    });

    describe('escalate', () => {
      it('should escalate incident', () => {
        const incident = createIncident({ status: IncidentStatus.NEW, escalationLevel: 0 });

        incident.escalate(1);

        expect(incident.escalationLevel).toBe(1);
        expect(incident.lastEscalatedAt).toBeInstanceOf(Date);
      });

      it('should add timeline event on escalate', () => {
        const incident = createIncident();

        incident.escalate(2);

        expect(incident.timeline).toHaveLength(1);
        expect(incident.timeline[0].type).toBe(TimelineEventType.ESCALATED);
      });

      it('should throw error when escalating non-escalatable incident', () => {
        const incident = createIncident({ status: IncidentStatus.RESOLVED });

        expect(() => incident.escalate(1)).toThrow('Incident cannot be escalated');
      });
    });
  });

  describe('timeline management', () => {
    describe('addTimelineEvent', () => {
      it('should add event with generated id and timestamp', () => {
        const incident = createIncident();

        incident.addTimelineEvent({
          type: TimelineEventType.COMMENT_ADDED,
          userId: 'user-1',
          description: 'Test comment',
        });

        expect(incident.timeline).toHaveLength(1);
        expect(incident.timeline[0].id).toBeDefined();
        expect(incident.timeline[0].id).toContain('evt-');
        expect(incident.timeline[0].timestamp).toBeInstanceOf(Date);
      });

      it('should preserve event data in metadata', () => {
        const incident = createIncident();

        incident.addTimelineEvent({
          type: TimelineEventType.STATUS_CHANGE,
          data: { previousStatus: IncidentStatus.NEW, newStatus: IncidentStatus.ACKNOWLEDGED },
        });

        expect(incident.timeline[0].metadata).toEqual({
          previousStatus: IncidentStatus.NEW,
          newStatus: IncidentStatus.ACKNOWLEDGED,
        });
      });
    });

    describe('addComment', () => {
      it('should add comment to timeline', () => {
        const incident = createIncident();

        incident.addComment('user-1', 'This is a comment');

        expect(incident.timeline).toHaveLength(1);
        expect(incident.timeline[0].type).toBe(TimelineEventType.COMMENT_ADDED);
        expect(incident.timeline[0].description).toBe('This is a comment');
        expect(incident.timeline[0].userId).toBe('user-1');
      });
    });

    describe('getLatestTimelineEvent', () => {
      it('should return latest event', () => {
        const incident = createIncident();

        incident.addComment('user-1', 'First comment');
        incident.addComment('user-2', 'Second comment');

        const latest = incident.getLatestTimelineEvent();

        expect(latest?.description).toBe('Second comment');
        expect(latest?.userId).toBe('user-2');
      });

      it('should return undefined for empty timeline', () => {
        const incident = createIncident();

        const latest = incident.getLatestTimelineEvent();

        expect(latest).toBeUndefined();
      });
    });

    describe('getTimelineEventsByType', () => {
      it('should filter events by type', () => {
        const incident = createIncident();

        incident.addComment('user-1', 'Comment 1');
        incident.acknowledge('user-1');
        incident.addComment('user-1', 'Comment 2');

        const comments = incident.getTimelineEventsByType(TimelineEventType.COMMENT_ADDED);

        expect(comments).toHaveLength(2);
        expect(comments.every(e => e.type === TimelineEventType.COMMENT_ADDED)).toBe(true);
      });

      it('should return empty array for no matching events', () => {
        const incident = createIncident();

        incident.addComment('user-1', 'Comment');

        const escalations = incident.getTimelineEventsByType(TimelineEventType.ESCALATED);

        expect(escalations).toHaveLength(0);
      });
    });
  });

  describe('occurrence tracking', () => {
    describe('recordOccurrence', () => {
      it('should increment occurrence count', () => {
        const incident = createIncident({ occurrenceCount: 1 });

        incident.recordOccurrence();

        expect(incident.occurrenceCount).toBe(2);
      });

      it('should update lastOccurredAt', () => {
        const incident = createIncident();

        incident.recordOccurrence();

        expect(incident.lastOccurredAt).toBeInstanceOf(Date);
      });
    });
  });

  describe('incident linking', () => {
    describe('linkIncident', () => {
      it('should add incident to related list', () => {
        const incident = createIncident();

        incident.linkIncident('incident-2');

        expect(incident.relatedIncidentIds).toContain('incident-2');
      });

      it('should not add duplicate incident', () => {
        const incident = createIncident({ relatedIncidentIds: ['incident-2'] });

        incident.linkIncident('incident-2');

        expect(incident.relatedIncidentIds.filter(id => id === 'incident-2')).toHaveLength(1);
      });
    });

    describe('unlinkIncident', () => {
      it('should remove incident from related list', () => {
        const incident = createIncident({ relatedIncidentIds: ['incident-2', 'incident-3'] });

        incident.unlinkIncident('incident-2');

        expect(incident.relatedIncidentIds).not.toContain('incident-2');
        expect(incident.relatedIncidentIds).toContain('incident-3');
      });

      it('should handle unlinking non-existent incident', () => {
        const incident = createIncident({ relatedIncidentIds: ['incident-2'] });

        incident.unlinkIncident('incident-99');

        expect(incident.relatedIncidentIds).toHaveLength(1);
      });
    });
  });

  describe('duration calculations', () => {
    describe('getDuration', () => {
      it('should return duration for resolved incident', () => {
        const createdAt = new Date('2024-01-01T10:00:00Z');
        const resolvedAt = new Date('2024-01-01T12:00:00Z');

        const incident = createIncident({ createdAt, resolvedAt });

        const duration = incident.getDuration();

        expect(duration).toBe(2 * 60 * 60 * 1000); // 2 hours in ms
      });

      it('should return ongoing duration for open incident', () => {
        const createdAt = new Date(Date.now() - 3600000); // 1 hour ago

        const incident = createIncident({ createdAt, status: IncidentStatus.NEW });

        const duration = incident.getDuration();

        expect(duration).toBeGreaterThanOrEqual(3600000);
        expect(duration).toBeLessThan(3700000);
      });
    });

    describe('getTimeToAcknowledge', () => {
      it('should return time to acknowledge', () => {
        const createdAt = new Date('2024-01-01T10:00:00Z');
        const acknowledgedAt = new Date('2024-01-01T10:15:00Z');

        const incident = createIncident({ createdAt, acknowledgedAt });

        const time = incident.getTimeToAcknowledge();

        expect(time).toBe(15 * 60 * 1000); // 15 minutes in ms
      });

      it('should return null if not acknowledged', () => {
        const incident = createIncident();

        const time = incident.getTimeToAcknowledge();

        expect(time).toBeNull();
      });
    });

    describe('getTimeToResolve', () => {
      it('should return time to resolve', () => {
        const createdAt = new Date('2024-01-01T10:00:00Z');
        const resolvedAt = new Date('2024-01-01T14:00:00Z');

        const incident = createIncident({ createdAt, resolvedAt });

        const time = incident.getTimeToResolve();

        expect(time).toBe(4 * 60 * 60 * 1000); // 4 hours in ms
      });

      it('should return null if not resolved', () => {
        const incident = createIncident();

        const time = incident.getTimeToResolve();

        expect(time).toBeNull();
      });
    });
  });

  describe('full lifecycle test', () => {
    it('should handle complete incident lifecycle', () => {
      const incident = createIncident();

      // Initial state
      expect(incident.isOpen()).toBe(true);
      expect(incident.isClosed()).toBe(false);

      // Acknowledge
      incident.acknowledge('user-1', 'Looking into it');
      expect(incident.status).toBe(IncidentStatus.ACKNOWLEDGED);

      // Assign
      incident.assign('user-2', 'user-1');
      expect(incident.assignedTo).toBe('user-2');

      // Start investigation
      incident.startInvestigation('user-2');
      expect(incident.status).toBe(IncidentStatus.INVESTIGATING);

      // Add comment
      incident.addComment('user-2', 'Found the root cause');

      // Resolve
      incident.resolve('user-2', 'Applied fix');
      expect(incident.status).toBe(IncidentStatus.RESOLVED);
      expect(incident.isOpen()).toBe(false);

      // Close
      incident.close('user-1');
      expect(incident.status).toBe(IncidentStatus.CLOSED);
      expect(incident.isClosed()).toBe(true);

      // Verify timeline
      expect(incident.timeline.length).toBe(5);
      expect(incident.timeline[0].type).toBe(TimelineEventType.ACKNOWLEDGED);
      expect(incident.timeline[1].type).toBe(TimelineEventType.ASSIGNED);
      expect(incident.timeline[2].type).toBe(TimelineEventType.STATUS_CHANGE);
      expect(incident.timeline[3].type).toBe(TimelineEventType.COMMENT_ADDED);
      expect(incident.timeline[4].type).toBe(TimelineEventType.RESOLVED);
    });

    it('should handle reopen and re-resolve cycle', () => {
      const incident = createIncident({ status: IncidentStatus.RESOLVED });

      // Reopen
      incident.reopen('user-1', 'Issue recurred');
      expect(incident.status).toBe(IncidentStatus.NEW);
      expect(incident.isOpen()).toBe(true);

      // Acknowledge again
      incident.acknowledge('user-2');

      // Resolve again
      incident.resolve('user-2', 'Applied permanent fix');
      expect(incident.status).toBe(IncidentStatus.RESOLVED);
    });

    it('should handle escalation flow', () => {
      const incident = createIncident();

      // Escalate through levels
      incident.escalate(1);
      expect(incident.escalationLevel).toBe(1);

      incident.escalate(2);
      expect(incident.escalationLevel).toBe(2);

      incident.escalate(3);
      expect(incident.escalationLevel).toBe(3);

      // Verify escalation events in timeline
      const escalationEvents = incident.getTimelineEventsByType(TimelineEventType.ESCALATED);
      expect(escalationEvents).toHaveLength(3);
    });
  });
});
