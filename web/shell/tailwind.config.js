/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../shared-ui/src/**/*.{js,ts,jsx,tsx}',
    '../modules/sensor-module/src/**/*.{js,ts,jsx,tsx}',
    '../modules/farm-module/src/**/*.{js,ts,jsx,tsx}',
    '../modules/hr-module/src/**/*.{js,ts,jsx,tsx}',
    '../modules/tenant-admin/src/**/*.{js,ts,jsx,tsx}',
    '../modules/admin-panel/src/**/*.{js,ts,jsx,tsx}',
    '../modules/dashboard/src/**/*.{js,ts,jsx,tsx}',
    '../modules/hydroponics-module/src/**/*.{js,ts,jsx,tsx}',
  ],
  // Shared UI'dan theme'i extend et
  presets: [
    require('../shared-ui/tailwind.config.js'),
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
