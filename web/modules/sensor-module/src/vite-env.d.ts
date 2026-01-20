/// <reference types="vite/client" />

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
