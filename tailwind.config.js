/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    './public/index.html',
  ],
  theme: {
    extend: {
      colors: {
        primary: '#714B67',
        secondary: '#64748b',
        success: '#22c55e',
        danger: '#ef4444',
        background: '#0b0f17',
        card: '#111827',
        dark: '#0f172a',
        border: '#1f2937',
        text: '#e5e7eb',
        textSecondary: '#9ca3af',
      },
      borderRadius: {
        brand: '12px'
      },
      boxShadow: {
        brand: '0 10px 20px rgba(0,0,0,0.35)',
        soft: '0 6px 14px rgba(0,0,0,0.25)'
      },
      fontFamily: {
        heading: ['Manrope', 'Noto Sans', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        body: ['Manrope', 'Noto Sans', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif']
      }
    },
  },
  plugins: [],
}
