/// <reference types="vite/client" />

/**
 * The build-time env this package reads. Declared here for the same reason the
 * shell and tenant-admin declare theirs: without it `import.meta.env.VITE_WS_URL`
 * does not typecheck, and the SCADA socket's URL resolution was reaching the
 * value through a double cast instead.
 */
interface ImportMetaEnv {
  readonly VITE_WS_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// SVG imports as React components (using vite-plugin-svgr)
declare module '*.svg?react' {
  import React from 'react';
  const SVGComponent: React.FC<React.SVGProps<SVGSVGElement>>;
  export default SVGComponent;
}

// SVG imports as URL
declare module '*.svg' {
  const content: string;
  export default content;
}
