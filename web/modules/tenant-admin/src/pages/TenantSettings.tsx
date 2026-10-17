import React, { useState } from 'react';
import {
  Building2,
  Bell,
  Shield,
  Globe,
  Smartphone,
  Sparkles,
  ChevronRight,
  Lock,
} from 'lucide-react';
import { useAuthContext, PageHeader } from '@aquaculture/shared-ui';
import {
  GeneralSettings,
  NotificationSettings,
  SecuritySettings,
  LocalizationSettings,
  MobileSettings,
  AiAssistantSettings,
} from '../components/settings';
import { SD_CARD } from '../components/ui/suderra';
import { SelectableRow } from '../components/ui/SelectableRow';

/**
 * Settings section definition.
 */
interface SettingsSection {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  /** When true, the section is only listed for TENANT_ADMIN (or higher). */
  adminOnly?: boolean;
}

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
    id: 'mobileUsers',
    title: 'Mobile Users',
    description: 'AquaMobil access and feature permissions',
    icon: <Smartphone className="w-5 h-5" />,
  },
  {
    id: 'ai',
    title: 'AI Assistant',
    description: 'Bring-your-own-key provider, model, budget and limits',
    icon: <Sparkles className="w-5 h-5" />,
    // AI provider settings (BYOK key) are TENANT_ADMIN by default (ai_settings:
    // manage); hidden from lower roles so they don't hit a 403 on the read.
    adminOnly: true,
  },
];

/**
 * TenantSettings Page -- tab navigation + section composition.
 *
 * SEC-007: Only TENANT_ADMIN (or higher) can modify settings.
 * Lower roles see a read-only view with editing controls disabled.
 *
 * Each section is a self-contained component that manages its own data
 * fetching, form state, and save logic.
 */
const TenantSettings: React.FC = () => {
  const { hasRoleOrHigher } = useAuthContext();
  const canEditSettings = hasRoleOrHigher('TENANT_ADMIN');
  const [activeSection, setActiveSection] = useState('general');

  // Hide admin-only sections (e.g. AI provider keys) from lower roles.
  const visibleSections = settingsSections.filter(
    (section) => !section.adminOnly || canEditSettings,
  );

  const renderSection = () => {
    switch (activeSection) {
      case 'general':
        return <GeneralSettings canEdit={canEditSettings} />;
      case 'notifications':
        return <NotificationSettings />;
      case 'security':
        return <SecuritySettings canEdit={canEditSettings} />;
      case 'localization':
        return <LocalizationSettings canEdit={canEditSettings} />;
      case 'mobileUsers':
        return <MobileSettings />;
      case 'ai':
        return <AiAssistantSettings canEdit={canEditSettings} />;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Settings"
        description="Manage your tenant settings and preferences"
        actions={
          <>
            {!canEditSettings && (
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-warning-700 dark:text-warning-300 bg-warning-50 dark:bg-warning-900/20 rounded-lg border border-warning-200 dark:border-warning-800">
                <Lock className="w-3.5 h-3.5" />
                Read-only access
              </div>
            )}
          </>
        }
      />

      {/* Settings Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar Navigation */}
        <div className="lg:col-span-1">
          <div className={SD_CARD}>
            {/* The section shown is the nav's current page: SelectableRow
                announces it (aria-current="page") and marks it with the
                accent line and fill, not by hue alone — in the Company
                workspace the slate accent sits 1.35:1 from the gray label. */}
            <nav className="divide-y divide-gray-100 dark:divide-gray-700">
              {visibleSections.map((section) => {
                const current = activeSection === section.id;
                return (
                  <SelectableRow
                    key={section.id}
                    current={current}
                    currentKind="page"
                    onSelect={() => setActiveSection(section.id)}
                    className={`flex items-center gap-3 px-4 py-3 ${
                      current
                        ? 'text-primary-900 dark:text-primary-100'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <span
                      className={`flex-shrink-0 ${
                        current
                          ? 'text-primary-700 dark:text-primary-300'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {section.icon}
                    </span>
                    <span className="block flex-1 min-w-0">
                      <span
                        className={`block text-sm truncate ${current ? 'font-semibold' : 'font-medium'}`}
                      >
                        {section.title}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400 truncate hidden sm:block">
                        {section.description}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className={`w-4 h-4 flex-shrink-0 ${
                        current
                          ? 'text-primary-700 dark:text-primary-300'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    />
                  </SelectableRow>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Settings Content */}
        <div className="lg:col-span-3">
          <div className={`${SD_CARD} p-6`}>
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {settingsSections.find((s) => s.id === activeSection)?.title}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
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
