import konstaConfig from 'konsta/config';

/** @type {import('tailwindcss').Config} */
export default konstaConfig({
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['DM Sans', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['DM Sans', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Ocean blue — aligned with main platform #0073e6
        ocean: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bbdaff',
          300: '#8dc3ff',
          400: '#57a1ff',
          500: '#3080ff',
          600: '#0073e6',
          700: '#0f5bcc',
          800: '#134ba5',
          900: '#164082',
          950: '#0f2952',
        },
        // Sea green — secondary
        sea: {
          50: '#ecfdf7',
          100: '#d1faeb',
          200: '#a7f3da',
          300: '#6ee7bf',
          400: '#34d39e',
          500: '#00e68a',
          600: '#00b36b',
          700: '#009058',
          800: '#007147',
          900: '#005d3b',
        },
        // Coral accent
        coral: {
          50: '#fff5f2',
          100: '#ffe8e0',
          200: '#ffd4c7',
          300: '#ffb59e',
          400: '#ff8f73',
          500: '#f97048',
          600: '#e6542e',
          700: '#c2401e',
          800: '#a0361d',
          900: '#84301e',
        },
        // Status colors
        mortality: {
          light: '#fde8e8',
          DEFAULT: '#dc2626',
          dark: '#991b1b',
        },
        cull: {
          light: '#fff0e0',
          DEFAULT: '#ea580c',
          dark: '#9a3412',
        },
        harvest: {
          light: '#f0e6ff',
          DEFAULT: '#7c3aed',
          dark: '#5b21b6',
        },
      },
      boxShadow: {
        'card': '0 1px 3px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.06)',
        'card-hover': '0 4px 16px rgba(0,0,0,0.1)',
        'elevated': '0 8px 30px rgba(0,0,0,0.12)',
        // WHY: Glow shadows provide a colored halo on selected/active elements — reinforces
        // the status color coding system (ocean=info, red=mortality, orange=cull, etc.)
        'glow-ocean': '0 4px 24px rgba(0,115,230,0.25)',
        'glow-red': '0 4px 20px rgba(220,38,38,0.2)',
        'glow-orange': '0 4px 20px rgba(234,88,12,0.2)',
        'glow-purple': '0 4px 20px rgba(124,58,237,0.2)',
        'glow-green': '0 4px 20px rgba(34,197,94,0.2)',
        'glow-blue': '0 4px 20px rgba(59,130,246,0.2)',
        'inner-glow': 'inset 0 1px 0 rgba(255,255,255,0.1)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.25rem',
      },
      // Safe area for iPhone notch
      spacing: {
        safe: 'env(safe-area-inset-bottom)',
        'safe-top': 'env(safe-area-inset-top)',
        'safe-left': 'env(safe-area-inset-left)',
        'safe-right': 'env(safe-area-inset-right)',
        // MOB-MEDIUM-009: the 44px gloved-use touch-target floor. Interactive
        // elements use `min-h-touch min-w-touch` — enforced by
        // src/__tests__/field-ergonomics.invariant.spec.ts.
        touch: '2.75rem',
      },
    },
  },
  plugins: [],
});
