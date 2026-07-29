/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,tsx,ts}', './src/mobile/**/*.{html,tsx,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', '-apple-system', 'system-ui', 'sans-serif'],
      },
      colors: {
        surface: {
          0: 'var(--color-surface-0)',
          1: 'var(--color-surface-1)',
          2: 'var(--color-surface-2)',
          3: 'var(--color-surface-3)',
          4: 'var(--color-surface-4)',
        },
        text: {
          1: 'var(--color-text-1)',
          2: 'var(--color-text-2)',
          3: 'var(--color-text-3)',
        },
        'roca-border': {
          1: 'var(--color-border-1)',
          2: 'var(--color-border-2)',
        },
        blue: {
          1: 'var(--color-blue-1)',
          2: 'var(--color-blue-2)',
        },
        green: {
          1: 'var(--color-green-1)',
          2: 'var(--color-green-2)',
        },
        red: {
          1: 'var(--color-red-1)',
          2: 'var(--color-red-2)',
        },
        purple: {
          1: 'var(--color-purple-1)',
          2: 'var(--color-purple-2)',
        },
      },
    },
  },
  plugins: [],
}
