/**
 * Dashboard Module - Standalone App Wrapper
 *
 * Used for local development without the shell host.
 * In production, the Module Federation host provides the context providers.
 */

import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider, TenantProvider } from '@aquaculture/shared-ui';
import DashboardModule from './Module';
import './styles.css';

const App: React.FC = () => {
  return (
    <BrowserRouter basename="/dashboard">
      <AuthProvider autoCheck={false}>
        <TenantProvider>
          <div className="min-h-screen bg-gray-50 p-6">
            <DashboardModule />
          </div>
        </TenantProvider>
      </AuthProvider>
    </BrowserRouter>
  );
};

export default App;
