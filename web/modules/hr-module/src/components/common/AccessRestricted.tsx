/**
 * AccessRestricted — what a page shows a reader whose role the HR service would refuse.
 *
 * A manager-only screen decides before it reads anything and answers with this instead of an
 * error state, so the refused reads are never sent. The page names what is restricted; the
 * heading and the way back are the same everywhere.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useI18n, type MessageKey } from '@aquaculture/shared-ui';

interface AccessRestrictedProps {
  /** Message key of the sentence saying which records are restricted. */
  messageKey: MessageKey;
}

export function AccessRestricted({ messageKey }: AccessRestrictedProps): React.ReactElement {
  const { t } = useI18n();

  return (
    <div
      role="alert"
      className="flex h-64 flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <div className="rounded-lg bg-error-100 p-4 dark:bg-error-900/30">
        <Lock className="h-8 w-8 text-error-600 dark:text-error-400" />
      </div>
      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">
          {t('hr.restricted.title')}
        </h2>
        <p className="mt-1 text-gray-500 dark:text-gray-400">{t(messageKey)}</p>
      </div>
      <Link
        to="/hr"
        className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
      >
        {t('hr.restricted.back')}
      </Link>
    </div>
  );
}

export default AccessRestricted;
