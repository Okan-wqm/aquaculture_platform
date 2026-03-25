import { useContext } from 'react';
import { ThemeContext, type ThemeContextValue } from './ThemeProvider';

/**
 * Safe version of useTheme that returns null when ThemeProvider is not mounted.
 * Use this in components that need backward compatibility with non-themed rendering.
 */
export function useThemeSafe(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
