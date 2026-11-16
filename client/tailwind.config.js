/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      colors: {
        canvas: {
          DEFAULT: '#09090B',
          elevated: '#111115',
          card: '#15151B',
          hover: '#1C1C24',
          muted: '#23232E',
        },
        brand: {
          DEFAULT: '#7C5CFF',
          hover: '#6D4AFF',
          muted: 'rgba(124, 92, 255, 0.14)',
          cyan: '#38BDF8',
        },
      },
      boxShadow: {
        studio: '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 16px 40px -12px rgba(0,0,0,0.65)',
        glow: '0 0 0 1px rgba(124, 92, 255, 0.35), 0 8px 28px -6px rgba(124, 92, 255, 0.25)',
      },
    },
  },
  plugins: [],
};
