/**
 * Pre-configured BrowserRouter with React Router v7 future flags
 *
 * This component centralizes the future flag configuration to avoid
 * deprecation warnings across all microfrontends using Module Federation.
 */

import React from 'react';
import { BrowserRouter, BrowserRouterProps } from 'react-router-dom';

export interface ConfiguredBrowserRouterProps extends Omit<BrowserRouterProps, 'future'> {
  children: React.ReactNode;
}

/**
 * BrowserRouter with React Router v7 future flags enabled
 * Use this instead of BrowserRouter from react-router-dom to opt-in to v7 behavior
 */
export const ConfiguredBrowserRouter: React.FC<ConfiguredBrowserRouterProps> = ({
  children,
  ...props
}) => {
  return (
    <BrowserRouter
      {...props}
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      {children}
    </BrowserRouter>
  );
};

export default ConfiguredBrowserRouter;
