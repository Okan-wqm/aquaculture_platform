/**
 * Not Found / Error Page
 *
 * Rendered for 404, authorization errors, and unexpected server errors.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@aquaculture/shared-ui';
import { Frown, Lock, TriangleAlert } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface NotFoundPageProps {
  type?: 'notfound' | 'unauthorized' | 'error';
}

// ============================================================================
// Page Content Configuration
// ============================================================================

const pageContent = {
  notfound: {
    code: '404',
    title: 'Page Not Found',
    description: 'The page you are looking for does not exist or may have been moved.',
    icon: <Frown className="w-24 h-24" aria-hidden="true" />,
  },
  unauthorized: {
    code: '403',
    title: 'Access Denied',
    description: 'You do not have permission to access this page.',
    icon: <Lock className="w-24 h-24" aria-hidden="true" />,
  },
  error: {
    code: '500',
    title: 'Server Error',
    description: 'An unexpected error occurred. Please try again later.',
    icon: <TriangleAlert className="w-24 h-24" aria-hidden="true" />,
  },
};

// ============================================================================
// Component
// ============================================================================

const NotFoundPage: React.FC<NotFoundPageProps> = ({ type = 'notfound' }) => {
  const content = pageContent[type];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800 flex items-center justify-center p-4">
      <div className="text-center max-w-md">
        <div className="text-gray-300 mb-6 flex justify-center">{content.icon}</div>
        <div className="text-6xl font-bold text-gray-200 mb-4">{content.code}</div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
          {content.title}
        </h1>
        <p className="text-gray-600 dark:text-gray-400 mb-8">{content.description}</p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link to="/">
            <Button variant="primary">Go to Home</Button>
          </Link>
          <Button variant="outline" onClick={() => window.history.back()}>
            Go Back
          </Button>
        </div>

        <p className="mt-8 text-sm text-gray-500 dark:text-gray-400">
          If the issue persists, please contact{' '}
          <a
            href="/support"
            className="text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-200 font-medium"
          >
            support
          </a>
          .
        </p>
      </div>
    </div>
  );
};

export default NotFoundPage;
