import { BaseEntity, BaseEntityWithCode } from '../entities/base.entity';

// Test için concrete class
class TestEntity extends BaseEntity {
  name: string;
}

class TestEntityWithCode extends BaseEntityWithCode {}

describe('BaseEntity', () => {
  let entity: TestEntity;

  beforeEach(() => {
    entity = new TestEntity();
    entity.id = 'test-uuid';
    entity.tenantId = 'tenant-uuid';
    entity.createdAt = new Date();
    entity.updatedAt = new Date();
    entity.version = 1;
    entity.isDeleted = false;
  });

  describe('softDelete', () => {
    it('should set isDeleted to true', () => {
      entity.softDelete();

      expect(entity.isDeleted).toBe(true);
    });

    it('should set deletedAt to current date', () => {
      const beforeDelete = new Date();
      entity.softDelete();
      const afterDelete = new Date();

      expect(entity.deletedAt).toBeDefined();
      expect(entity.deletedAt.getTime()).toBeGreaterThanOrEqual(beforeDelete.getTime());
      expect(entity.deletedAt.getTime()).toBeLessThanOrEqual(afterDelete.getTime());
    });

    it('should set deletedBy when provided', () => {
      const userId = 'user-123';
      entity.softDelete(userId);

      expect(entity.deletedBy).toBe(userId);
    });

    it('should work without deletedBy parameter', () => {
      entity.softDelete();

      expect(entity.deletedBy).toBeUndefined();
    });
  });

  describe('restore', () => {
    beforeEach(() => {
      // First soft delete
      entity.softDelete('user-123');
    });

    it('should set isDeleted to false', () => {
      entity.restore();

      expect(entity.isDeleted).toBe(false);
    });

    it('should clear deletedAt', () => {
      entity.restore();

      expect(entity.deletedAt).toBeUndefined();
    });

    it('should clear deletedBy', () => {
      entity.restore();

      expect(entity.deletedBy).toBeUndefined();
    });
  });
});

describe('BaseEntityWithCode', () => {
  let entity: TestEntityWithCode;

  beforeEach(() => {
    entity = new TestEntityWithCode();
    entity.id = 'test-uuid';
    entity.tenantId = 'tenant-uuid';
    entity.name = 'Test Entity';
    entity.code = 'TEST-001';
    entity.isActive = true;
  });

  it('should have name, code and isActive properties', () => {
    expect(entity.name).toBe('Test Entity');
    expect(entity.code).toBe('TEST-001');
    expect(entity.isActive).toBe(true);
  });

  it('should allow optional description', () => {
    expect(entity.description).toBeUndefined();

    entity.description = 'Test description';
    expect(entity.description).toBe('Test description');
  });

  it('should inherit soft delete functionality', () => {
    entity.softDelete('user-123');

    expect(entity.isDeleted).toBe(true);
    expect(entity.deletedBy).toBe('user-123');
  });
});
