// SPA entry point.
//
// WHY: a single mount keeps the auth boundary (token in sessionStorage) and the
// health probe (actionsEnabled) above every route, so no page can render a
// mutating control before the server has said whether actions are allowed.
// WHAT: mounts the router inside StrictMode; global CSS is imported once here.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { appRouter } from './app/router.tsx';
import './design/tokens.css';
import './design/base.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html must contain <div id="root">; the SPA has nowhere to mount.');
}

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={appRouter} />
  </StrictMode>,
);
