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
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 rounded-lg border border-amber-200">
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
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 overflow-hidden">
            <nav className="divide-y divide-gray-100 dark:divide-gray-700">
              {visibleSections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                    activeSection === section.id
                      ? 'bg-green-50 text-green-700'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  <span
                    className={`flex-shrink-0 ${
                      activeSection === section.id ? 'text-green-600' : 'text-gray-500 dark:text-gray-400'
                    }`}
                  >
                    {section.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{section.title}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate hidden sm:block">
                      {section.description}
                    </p>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 flex-shrink-0 ${
                      activeSection === section.id ? 'text-green-600' : 'text-gray-500 dark:text-gray-400'
                    }`}
                  />
                </button>
              ))}
            </nav>
          </div>
        </div>

        {/* Settings Content */}
        <div className="lg:col-span-3">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 p-6">
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
