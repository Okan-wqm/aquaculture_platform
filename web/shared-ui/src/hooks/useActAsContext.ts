/**
 * useActAsContext — the SUPER_ADMIN act-as context as React state.
 *
 * The API client owns the context (session storage, request headers); this
 * subscribes to it so the shell can show a banner and an exit control instead
 * of acting on a tenant invisibly (FE-MEDIUM-092). `null` for everyone else.
 */

import { useSyncExternalStore } from 'react';

import { getActAsContext, subscribeActAsContext, type ActAsContext } from '../utils/api-client';

const getServerSnapshot = (): ActAsContext | null => null;

export function useActAsContext(): ActAsContext | null {
  return useSyncExternalStore(subscribeActAsContext, getActAsContext, getServerSnapshot);
}
