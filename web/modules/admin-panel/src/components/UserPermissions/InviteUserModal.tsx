import React, { useState, useEffect } from 'react';
import { PermissionCheckboxes } from './PermissionCheckboxes';

interface PermissionCategory {
  category: string;
  label: string;
  permissions: string[];
}

interface PanelPermissions {
  [category: string]: {
    [permission: string]: boolean;
  };
}

interface InviteUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvite: (data: InviteUserData) => Promise<void>;
  categories: PermissionCategory[];
  defaultPermissions: PanelPermissions;
  isLoading?: boolean;
}

interface InviteUserData {
  email: string;
  firstName?: string;
  lastName?: string;
  permissions: PanelPermissions;
  sendInvitationEmail: boolean;
}

// Default minimal permissions for new users
const getDefaultUserPermissions = (): PanelPermissions => ({
  dashboard: { view: true, viewAnalytics: false, exportReports: false },
  farms: { view: true, create: false, edit: false, delete: false },
  batches: { view: true, create: false, edit: false, delete: false, recordMortality: false, transfer: false },
  feeding: { view: true, createRecords: false, manageSchedules: false, manageInventory: false },
  sensors: { view: true, configure: false, manageAlerts: false, viewRawData: false },
  maintenance: { view: true, createWorkOrders: false, completeWorkOrders: false, manageSpareParts: false, manageSchedules: false },
  hr: { view: false, manageEmployees: false, manageAttendance: false, manageLeave: false, viewPayroll: false, managePayroll: false },
  reports: { view: true, export: false, createCustom: false },
  settings: { viewTenantSettings: false, editTenantSettings: false, manageIntegrations: false },
  users: { view: false, invite: false, editPermissions: false, deactivate: false },
});

export const InviteUserModal: React.FC<InviteUserModalProps> = ({
  isOpen,
  onClose,
  onInvite,
  categories,
  defaultPermissions,
  isLoading = false,
}) => {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [permissions, setPermissions] = useState<PanelPermissions>(defaultPermissions || getDefaultUserPermissions());
  const [sendEmail, setSendEmail] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setEmail('');
      setFirstName('');
      setLastName('');
      setPermissions(defaultPermissions || getDefaultUserPermissions());
      setSendEmail(true);
      setError(null);
    }
  }, [isOpen, defaultPermissions]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    try {
      await onInvite({
        email: email.toLowerCase().trim(),
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        permissions,
        sendInvitationEmail: sendEmail,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite user');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="invite-modal-title">
        <div className="modal-header">
          <h2 id="invite-modal-title">Invite New User</h2>
          <button className="close-button" onClick={onClose} disabled={isLoading}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="error-message">{error}</div>}

            <div className="form-section">
              <h3>User Information</h3>

              <div className="form-group">
                <label htmlFor="email">Email Address *</label>
                <input
                  type="email"
                  id="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  required
                  disabled={isLoading}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="firstName">First Name</label>
                  <input
                    type="text"
                    id="firstName"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="John"
                    disabled={isLoading}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="lastName">Last Name</label>
                  <input
                    type="text"
                    id="lastName"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Doe"
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={sendEmail}
                    onChange={(e) => setSendEmail(e.target.checked)}
                    disabled={isLoading}
                  />
                  Send invitation email to user
                </label>
              </div>
            </div>

            <div className="form-section">
              <h3>Permissions</h3>
              <p className="section-description">
                Select which features this user can access. You can change these settings later.
              </p>

              <PermissionCheckboxes
                permissions={permissions}
                onChange={setPermissions}
                disabled={isLoading}
                categories={categories}
              />
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={isLoading}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={isLoading}>
              {isLoading ? 'Inviting...' : 'Send Invitation'}
            </button>
          </div>
        </form>

        <style>{`
          .modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
          }
          .modal-content {
            background: white;
            border-radius: 12px;
            width: 90%;
            max-width: 700px;
            max-height: 90vh;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
          }
          .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 24px;
            border-bottom: 1px solid #e0e0e0;
          }
          .modal-header h2 {
            margin: 0;
            font-size: 20px;
            font-weight: 600;
          }
          .close-button {
            background: none;
            border: none;
            font-size: 28px;
            cursor: pointer;
            color: #666;
            padding: 0;
            line-height: 1;
          }
          .close-button:hover {
            color: #333;
          }
          .modal-body {
            padding: 24px;
            overflow-y: auto;
            flex: 1;
          }
          .error-message {
            background: #ffebee;
            color: #c62828;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 16px;
          }
          .form-section {
            margin-bottom: 24px;
          }
          .form-section h3 {
            margin: 0 0 12px 0;
            font-size: 16px;
            font-weight: 600;
            color: #333;
          }
          .section-description {
            color: #666;
            font-size: 14px;
            margin: 0 0 16px 0;
          }
          .form-group {
            margin-bottom: 16px;
          }
          .form-group label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
            color: #333;
          }
          .form-group input[type="text"],
          .form-group input[type="email"] {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
          }
          .form-group input:focus {
            outline: none;
            border-color: #1976d2;
            box-shadow: 0 0 0 3px rgba(25, 118, 210, 0.1);
          }
          .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
          }
          .checkbox-group label {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
          }
          .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            padding: 16px 24px;
            border-top: 1px solid #e0e0e0;
          }
          .btn-primary, .btn-secondary {
            padding: 10px 20px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
          }
          .btn-primary {
            background: #1976d2;
            color: white;
            border: none;
          }
          .btn-primary:hover:not(:disabled) {
            background: #1565c0;
          }
          .btn-secondary {
            background: white;
            color: #333;
            border: 1px solid #ddd;
          }
          .btn-secondary:hover:not(:disabled) {
            background: #f5f5f5;
          }
          .btn-primary:disabled, .btn-secondary:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }
        `}</style>
      </div>
    </div>
  );
};

export default InviteUserModal;
