import { createRequire } from 'node:module';

import { act, cleanup, renderHook } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

const requireFromApp = createRequire(new URL('../../package.json', import.meta.url));
const requireFromRenderer = createRequire(requireFromApp.resolve('react-dom/client'));

describe('standalone React runtime', () => {
  afterEach(cleanup);

  it('uses the same React instance as the installed DOM renderer', () => {
    expect(React).toBe(requireFromRenderer('react'));
  });

  it('renders and updates hooks through the installed testing library', () => {
    const { result } = renderHook(() => useState(0));

    act(() => result.current[1](1));

    expect(result.current[0]).toBe(1);
  });
});
