import React from 'react';
import { Info } from 'lucide-react';

/**
 * LocalizationSettings -- "Coming Soon" banner (MED-01).
 *
 * SEC-005: Localization settings are NOT persisted to the backend.
 * Render a read-only banner with no interactive controls.
 */
const LocalizationSettings: React.FC = () => (
  <div className="space-y-6">
    <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
      <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
      <p className="text-sm text-amber-700">
        <strong>Not yet available:</strong> Localization settings are not
        currently persisted. This section is coming soon.
      </p>
    </div>
    <div className="p-6 bg-gray-50 rounded-lg text-center">
      <p className="text-sm text-gray-500">
        Language, timezone, and date format configuration will be available
        when the backend support is ready.
      </p>
    </div>
  </div>
);

export default LocalizationSettings;
