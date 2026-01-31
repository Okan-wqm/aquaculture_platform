import React, { useState, useCallback } from 'react';

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

interface PermissionCheckboxesProps {
  permissions: PanelPermissions;
  onChange: (permissions: PanelPermissions) => void;
  disabled?: boolean;
  categories: PermissionCategory[];
}

const PERMISSION_LABELS: Record<string, string> = {
  view: 'View',
  viewAnalytics: 'View Analytics',
  exportReports: 'Export Reports',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  recordMortality: 'Record Mortality',
  transfer: 'Transfer',
  createRecords: 'Create Records',
  manageSchedules: 'Manage Schedules',
  manageInventory: 'Manage Inventory',
  configure: 'Configure',
  manageAlerts: 'Manage Alerts',
  viewRawData: 'View Raw Data',
  createWorkOrders: 'Create Work Orders',
  completeWorkOrders: 'Complete Work Orders',
  manageSpareParts: 'Manage Spare Parts',
  manageEmployees: 'Manage Employees',
  manageAttendance: 'Manage Attendance',
  manageLeave: 'Manage Leave',
  viewPayroll: 'View Payroll',
  managePayroll: 'Manage Payroll',
  createCustom: 'Create Custom',
  viewTenantSettings: 'View Settings',
  editTenantSettings: 'Edit Settings',
  manageIntegrations: 'Manage Integrations',
  invite: 'Invite Users',
  editPermissions: 'Edit Permissions',
  deactivate: 'Deactivate Users',
};

export const PermissionCheckboxes: React.FC<PermissionCheckboxesProps> = ({
  permissions,
  onChange,
  disabled = false,
  categories,
}) => {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['dashboard', 'farms']));

  const toggleCategory = (category: string) => {
    const newExpanded = new Set(expandedCategories);
    if (newExpanded.has(category)) {
      newExpanded.delete(category);
    } else {
      newExpanded.add(category);
    }
    setExpandedCategories(newExpanded);
  };

  const handlePermissionChange = useCallback((category: string, permission: string, checked: boolean) => {
    const newPermissions = {
      ...permissions,
      [category]: {
        ...permissions[category],
        [permission]: checked,
      },
    };
    onChange(newPermissions);
  }, [permissions, onChange]);

  const handleSelectAllCategory = useCallback((category: string, categoryPermissions: string[], selectAll: boolean) => {
    const newCategoryPerms: Record<string, boolean> = {};
    categoryPermissions.forEach(perm => {
      newCategoryPerms[perm] = selectAll;
    });

    const newPermissions = {
      ...permissions,
      [category]: newCategoryPerms,
    };
    onChange(newPermissions);
  }, [permissions, onChange]);

  const isCategoryAllSelected = (category: string, categoryPermissions: string[]): boolean => {
    const catPerms = permissions[category] || {};
    return categoryPermissions.every(perm => catPerms[perm] === true);
  };

  const isCategorySomeSelected = (category: string, categoryPermissions: string[]): boolean => {
    const catPerms = permissions[category] || {};
    const selected = categoryPermissions.filter(perm => catPerms[perm] === true);
    return selected.length > 0 && selected.length < categoryPermissions.length;
  };

  return (
    <div className="permission-checkboxes">
      {categories.map(({ category, label, permissions: categoryPerms }) => {
        const isExpanded = expandedCategories.has(category);
        const allSelected = isCategoryAllSelected(category, categoryPerms);
        const someSelected = isCategorySomeSelected(category, categoryPerms);

        return (
          <div key={category} className="permission-category">
            <div className="category-header" onClick={() => toggleCategory(category)}>
              <span className="expand-icon" aria-hidden="true">{isExpanded ? '▼' : '▶'}</span>
              <label className="category-checkbox">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={(e) => {
                    e.stopPropagation();
                    handleSelectAllCategory(category, categoryPerms, e.target.checked);
                  }}
                  disabled={disabled}
                />
                <span className="category-label">{label}</span>
              </label>
            </div>

            {isExpanded && (
              <div className="permission-list">
                {categoryPerms.map(permission => (
                  <label key={permission} className="permission-item">
                    <input
                      type="checkbox"
                      checked={permissions[category]?.[permission] || false}
                      onChange={(e) => handlePermissionChange(category, permission, e.target.checked)}
                      disabled={disabled}
                    />
                    <span>{PERMISSION_LABELS[permission] || permission}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <style>{`
        .permission-checkboxes {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .permission-category {
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          overflow: hidden;
        }
        .category-header {
          display: flex;
          align-items: center;
          padding: 12px 16px;
          background: #f5f5f5;
          cursor: pointer;
          user-select: none;
        }
        .category-header:hover {
          background: #eeeeee;
        }
        .expand-icon {
          margin-right: 8px;
          font-size: 12px;
          color: #666;
        }
        .category-checkbox {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
        }
        .category-label {
          font-weight: 600;
          color: #333;
        }
        .permission-list {
          padding: 12px 16px 12px 40px;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: 8px;
        }
        .permission-item {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          padding: 4px 0;
        }
        .permission-item:hover {
          color: #1976d2;
        }
        .permission-item input[type="checkbox"] {
          width: 16px;
          height: 16px;
          cursor: pointer;
        }
        .permission-item input[type="checkbox"]:disabled {
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
};

export default PermissionCheckboxes;
