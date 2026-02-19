/**
 * Dashboard Module - MF Bootstrap
 *
 * Module Federation dynamic import bootstrap.
 * This file is the real entry point — main.tsx loads this asynchronously
 * to allow Module Federation's shared scope to initialise before React starts.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = document.getElementById('root');

if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
