/**
 * ReefScene — React mount for `<suderra-reef-scene>`, the underwater scene
 * behind the auth card (FE-HIGH-313). The element owns its shadow root,
 * animation loop and reduced-motion handling (reef/ReefSceneElement.ts); this
 * wrapper registers it and forwards the two attributes. It is decoration, so
 * it is hidden from assistive technology.
 */
import React from 'react';

import { REEF_SCENE_TAG, defineReefScene } from './reef/ReefSceneElement';
import type { ReefDensity } from './reef/species';

defineReefScene();

export interface ReefSceneProps {
  /** Fish roster size (default `high`) */
  density?: ReefDensity;
  /** `false` hides the kelp and eelgrass layer */
  plants?: boolean;
}

const ReefScene: React.FC<ReefSceneProps> = ({ density = 'high', plants = true }) =>
  React.createElement(REEF_SCENE_TAG, {
    'aria-hidden': 'true',
    density,
    plants: plants ? 'true' : 'false',
  });

export default ReefScene;
