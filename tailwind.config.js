/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        sanafi: {
          bg: '#0B1220',
          card: '#111A2E',
          border: '#1F2B46',
          accent: '#16A34A',
          warn: '#F59E0B',
          danger: '#EF4444',
          text: '#E5E7EB',
          muted: '#94A3B8',
        },
      },
      boxShadow: {
        panel: '0 8px 24px rgba(0,0,0,0.25)',
      },
    },
  },
  plugins: [],
}
