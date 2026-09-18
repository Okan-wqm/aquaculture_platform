/**
 * ReefScene — React mount for the `<suderra-reef-scene>` custom element.
 *
 * The element is a self-contained shadow-DOM scene (see reefScene.ts); this
 * wrapper only positions it behind the auth card and forwards the density /
 * plants attributes. Attributes are plain strings so React 19 passes them
 * through to the custom element untouched.
 */
import React from 'react';

import './reefScene';

export interface ReefSceneProps {
  /** Fish roster size — 'low' | 'med' | 'high' (default 'high'). */
  density?: 'low' | 'med' | 'high';
  /** Set false to hide the kelp/eelgrass layer. */
  plants?: boolean;
}

declare module 'react' {
  // JSX augmentation requires namespace syntax (React 19 types).
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'suderra-reef-scene': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        density?: string;
        plants?: string;
      };
    }
  }
}

const ReefScene: React.FC<ReefSceneProps> = ({ density = 'high', plants = true }) => (
  <suderra-reef-scene
    aria-hidden="true"
    density={density}
    plants={plants ? 'true' : 'false'}
    style={{ position: 'absolute', inset: 0, zIndex: 0 }}
  />
);

export default ReefScene;
