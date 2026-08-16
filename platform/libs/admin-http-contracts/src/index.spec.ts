import {
  ADMIN_HTTP_CONTRACT_VERSION,
  ADMIN_MESSAGING_AUDIT_QUERY_SUBJECT_V1,
} from './index';

describe('admin HTTP contracts', () => {
  it('pins versioned messaging audit coordinates', () => {
    expect(ADMIN_HTTP_CONTRACT_VERSION).toBe(1);
    expect(ADMIN_MESSAGING_AUDIT_QUERY_SUBJECT_V1).toBe(
      'request.messaging.admin.getAuditLog',
    );
  });
});
