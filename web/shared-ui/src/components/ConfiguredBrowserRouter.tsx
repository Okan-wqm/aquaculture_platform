/**
 * Shared BrowserRouter wrapper for federated web applications.
 *
 * React Router 7 makes the former v7 future behavior the default, so this
 * wrapper only centralizes the router boundary and its standard props.
 */

import React from 'react';
import { BrowserRouter, type BrowserRouterProps } from 'react-router-dom';

export interface ConfiguredBrowserRouterProps extends BrowserRouterProps {
  children: React.ReactNode;
}

/**
 * Use this instead of BrowserRouter to keep one declarative router boundary.
 */
export const ConfiguredBrowserRouter: React.FC<ConfiguredBrowserRouterProps> = ({
  children,
  ...props
}) => {
  return <BrowserRouter {...props}>{children}</BrowserRouter>;
};

export default ConfiguredBrowserRouter;
