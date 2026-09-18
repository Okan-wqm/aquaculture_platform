/**
 * Admin Panel Module - Standalone Entry Point
 *
 * Bağımsız geliştirme için kullanılır.
 * Production'da Module Federation ile yüklenir.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfiguredBrowserRouter, ConfirmProvider } from '@aquaculture/shared-ui';
import AdminPanelModule from './Module';
import './styles.css';

const root = document.getElementById('root');

if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ConfiguredBrowserRouter>
        <div className="min-h-screen bg-gray-50 p-6">
          <ConfirmProvider>
            <AdminPanelModule />
          </ConfirmProvider>
        </div>
      </ConfiguredBrowserRouter>
    </React.StrictMode>,
  );
}
