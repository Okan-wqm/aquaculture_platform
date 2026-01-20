/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../shared-ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  presets: [
    require('../../shared-ui/tailwind.config.js'),
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
