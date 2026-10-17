/**
 * useFollowedWorkspace writes `data-ws` before the browser paints
 * (FE-MEDIUM-348).
 *
 * `data-ws` on <html> picks the console's accent, its tinted ground and the
 * motif behind the column. Written from a passive effect, it landed after the
 * first paint: every entry into the console, and every move to another
 * workspace, showed one frame of the previous ground. Layout effects run
 * before the browser paints, so a sibling's layout effect sees exactly what
 * that first frame shows.
 */
import { render } from '@testing-library/react';
import { useLayoutEffect, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConsoleShellProvider } from '../../ConsoleShellContext';
import { CONSOLE_WORKSPACES } from '../../nav';
import { useFollowedWorkspace } from '../useFollowedWorkspace';

function Follower({ path }: { path: string }): null {
  useFollowedWorkspace(path, CONSOLE_WORKSPACES);
  return null;
}

/** Records `data-ws` from a layout effect — what the frame about to be painted shows. */
function FirstFrame({ seen }: { seen: Array<string | undefined> }): null {
  useLayoutEffect(() => {
    seen.push(document.documentElement.dataset.ws);
  });
  return null;
}

function Console({ path, seen }: { path: string; seen: Array<string | undefined> }): ReactElement {
  return (
    <ConsoleShellProvider tenantId="t1">
      <Follower path={path} />
      <FirstFrame seen={seen} />
    </ConsoleShellProvider>
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.ws;
});

describe('useFollowedWorkspace — data-ws before paint (FE-MEDIUM-348)', () => {
  it("paints the console's first frame in the workspace the route belongs to", () => {
    const seen: Array<string | undefined> = [];
    render(<Console path="/sites/tanks" seen={seen} />);
    expect(seen[0]).toBe('aqua');
  });

  it('paints the first frame after a move in the new workspace', () => {
    const seen: Array<string | undefined> = [];
    const { rerender } = render(<Console path="/sites/tanks" seen={seen} />);
    seen.length = 0;
    rerender(<Console path="/sensor/plc/alarms" seen={seen} />);
    expect(seen[0]).toBe('ctl');
  });

  it('removes data-ws when the console unmounts (sign-out, the SUPER_ADMIN console)', () => {
    const { unmount } = render(<Console path="/hydroponics/pid-simulator" seen={[]} />);
    expect(document.documentElement.dataset.ws).toBe('gh');
    unmount();
    expect(document.documentElement.dataset.ws).toBeUndefined();
  });
});
