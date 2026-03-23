import React from 'react';
import { AlertCircle } from 'lucide-react';

/**
 * SecuritySettings -- "Coming Soon" banner (MED-01).
 *
 * SEC-005: Security settings (2FA enforcement, session timeout, IP whitelist)
 * are NOT persisted to the backend. Render a read-only banner with no
 * interactive controls to avoid misleading the user.
 */
const SecuritySettings: React.FC = () => (
  <div className="space-y-6">
    <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
      <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
      <p className="text-sm text-red-700">
        <strong>Not yet available:</strong> Security settings (2FA enforcement,
        session timeout, IP whitelist) are not currently persisted. Contact your
        system administrator to configure these security controls.
      </p>
    </div>
    <div className="p-6 bg-gray-50 rounded-lg text-center">
      <p className="text-sm text-gray-500">
        This section will include two-factor authentication enforcement,
        session timeout configuration, and IP whitelisting when the backend
        support is ready.
      </p>
    </div>
  </div>
);

export default SecuritySettings;
