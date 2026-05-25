/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './web-cli/index.html', 
    './web-cli/src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"IBM Plex Mono"', 'monospace'],
        sans: ['"IBM Plex Sans"', 'sans-serif'],
      },
      colors: {
        bg:      '#080b0f',
        bg2:     '#0d1117',
        bg3:     '#161b22',
        border:  '#21262d',
        red:     '#ef4444',
        'red-dim': '#7f1d1d',
        green:   '#22c55e',
        amber:   '#f59e0b',
        blue:    '#38bdf8',
        purple:  '#a78bfa',
        muted:   '#4b5563',
        'text-base': '#e2e8f0',
        'text-dim':  '#6b7280',
      },
    },
  },
  plugins: [],
}
