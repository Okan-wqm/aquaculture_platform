import React, { useState } from 'react';
import {
  Building2,
  Bell,
  Shield,
  Globe,
  Palette,
  Save,
  ChevronRight,
  Info,
  Check,
} from 'lucide-react';

/**
 * Settings section type
 */
interface SettingsSection {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}

/**
 * Settings sections
 */
const settingsSections: SettingsSection[] = [
  {
    id: 'general',
    title: 'General',
    description: 'Basic tenant information and preferences',
    icon: <Building2 className="w-5 h-5" />,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Configure notification preferences',
    icon: <Bell className="w-5 h-5" />,
  },
  {
    id: 'security',
    title: 'Security',
    description: 'Security settings and access controls',
    icon: <Shield className="w-5 h-5" />,
  },
  {
    id: 'localization',
    title: 'Localization',
    description: 'Language and regional settings',
    icon: <Globe className="w-5 h-5" />,
  },
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Customize look and feel',
    icon: <Palette className="w-5 h-5" />,
  },
];

/**
 * Toggle switch component
 */
const Toggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  label: string;
  description?: string;
}> = ({ enabled, onChange, label, description }) => (
  <div className="flex items-center justify-between py-4">
    <div>
      <p className="text-sm font-medium text-gray-900">{label}</p>
      {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
    </div>
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:ring-offset-2 ${
        enabled ? 'bg-tenant-600' : 'bg-gray-200'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  </div>
);

/**
 * TenantSettings Page
 *
 * Settings management page for tenant admin.
 * Features:
 * - General settings (tenant name, contact info)
 * - Notification preferences
 * - Security settings
 * - Localization settings
 * - Appearance customization
 */
const TenantSettings: React.FC = () => {
  const [activeSection, setActiveSection] = useState('general');
  const [saved, setSaved] = useState(false);

  // Form state
  const [tenantName, setTenantName] = useState('Aqua Farm Co.');
  const [contactEmail, setContactEmail] = useState('admin@aquafarm.com');
  const [contactPhone, setContactPhone] = useState('+1 (555) 123-4567');
  const [address, setAddress] = useState('123 Ocean Drive, Coastal City, CC 12345');

  // Notification settings
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [alertNotifications, setAlertNotifications] = useState(true);
  const [weeklyReports, setWeeklyReports] = useState(false);
  const [userActivityAlerts, setUserActivityAlerts] = useState(true);

  // Security settings
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [sessionTimeout, setSessionTimeout] = useState('30');
  const [ipWhitelist, setIpWhitelist] = useState(false);

  // Localization settings
  const [language, setLanguage] = useState('en');
  const [timezone, setTimezone] = useState('UTC');
  const [dateFormat, setDateFormat] = useState('MM/DD/YYYY');

  const handleSave = () => {
    // Simulate save
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const renderSection = () => {
    switch (activeSection) {
      case 'general':
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tenant Name
              </label>
              <input
                type="text"
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Contact Email
              </label>
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Contact Phone
              </label>
              <input
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Address
              </label>
              <textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                rows={3}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent resize-none"
              />
            </div>
          </div>
        );

      case 'notifications':
        return (
          <div className="divide-y divide-gray-100">
            <Toggle
              enabled={emailNotifications}
              onChange={setEmailNotifications}
              label="Email Notifications"
              description="Receive important updates via email"
            />
            <Toggle
              enabled={alertNotifications}
              onChange={setAlertNotifications}
              label="Alert Notifications"
              description="Get notified about critical alerts"
            />
            <Toggle
              enabled={weeklyReports}
              onChange={setWeeklyReports}
              label="Weekly Reports"
              description="Receive weekly summary reports"
            />
            <Toggle
              enabled={userActivityAlerts}
              onChange={setUserActivityAlerts}
              label="User Activity Alerts"
              description="Get notified about user login activities"
            />
          </div>
        );

      case 'security':
        return (
          <div className="space-y-6">
            <Toggle
              enabled={twoFactorRequired}
              onChange={setTwoFactorRequired}
              label="Require Two-Factor Authentication"
              description="All users must enable 2FA to access the system"
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Session Timeout (minutes)
              </label>
              <select
                value={sessionTimeout}
                onChange={(e) => setSessionTimeout(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
              >
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
                <option value="120">2 hours</option>
                <option value="480">8 hours</option>
              </select>
            </div>
            <Toggle
              enabled={ipWhitelist}
              onChange={setIpWhitelist}
              label="IP Whitelist"
              description="Restrict access to specific IP addresses"
            />
            {ipWhitelist && (
              <div className="p-4 bg-yellow-50 rounded-lg">
                <div className="flex gap-2">
                  <Info className="w-5 h-5 text-yellow-600 flex-shrink-0" />
                  <p className="text-sm text-yellow-700">
                    Contact your administrator to configure IP whitelist rules.
                  </p>
                </div>
              </div>
            )}
          </div>
        );

      case 'localization':
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Language
              </label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
              >
                <option value="en">English</option>
                <option value="tr">Turkish</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Timezone
              </label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
              >
                <option value="UTC">UTC</option>
                <option value="Europe/Istanbul">Europe/Istanbul (UTC+3)</option>
                <option value="America/New_York">America/New York (UTC-5)</option>
                <option value="America/Los_Angeles">America/Los Angeles (UTC-8)</option>
                <option value="Asia/Tokyo">Asia/Tokyo (UTC+9)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date Format
              </label>
              <select
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
              >
                <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              </select>
            </div>
          </div>
        );

      case 'appearance':
        return (
          <div className="space-y-6">
            <div className="p-6 bg-gray-50 rounded-lg text-center">
              <Palette className="w-12 h-12 text-gray-400 mx-auto" />
              <h3 className="mt-4 text-sm font-medium text-gray-900">
                Appearance Settings
              </h3>
              <p className="mt-2 text-sm text-gray-500">
                Custom theming and branding options coming soon.
              </p>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage your tenant settings and preferences
          </p>
        </div>
        <button
          onClick={handleSave}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors"
        >
          {saved ? (
            <>
              <Check className="w-4 h-4" />
              Saved!
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              Save Changes
            </>
          )}
        </button>
      </div>

      {/* Settings Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar Navigation */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <nav className="divide-y divide-gray-100">
              {settingsSections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                    activeSection === section.id
                      ? 'bg-tenant-50 text-tenant-700'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <span
                    className={`flex-shrink-0 ${
                      activeSection === section.id
                        ? 'text-tenant-600'
                        : 'text-gray-400'
                    }`}
                  >
                    {section.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{section.title}</p>
                    <p className="text-xs text-gray-500 truncate hidden sm:block">
                      {section.description}
                    </p>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 flex-shrink-0 ${
                      activeSection === section.id
                        ? 'text-tenant-600'
                        : 'text-gray-400'
                    }`}
                  />
                </button>
              ))}
            </nav>
          </div>
        </div>

        {/* Settings Content */}
        <div className="lg:col-span-3">
          <div className="bg-white rounded-xl border border-gray-100 p-6">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">
                {settingsSections.find((s) => s.id === activeSection)?.title}
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                {settingsSections.find((s) => s.id === activeSection)?.description}
              </p>
            </div>
            {renderSection()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantSettings;
