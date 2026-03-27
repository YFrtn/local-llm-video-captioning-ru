/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#07121D',
        mist: '#EAF3FA',
        ember: '#F29F67',
        tide: '#74C6DD',
        leaf: '#A8D68C',
      },
      boxShadow: {
        panel: '0 28px 80px rgba(7, 18, 29, 0.28)',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        body: ['"Manrope"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
      backgroundImage: {
        'mesh-gradient':
          'radial-gradient(circle at top left, rgba(242, 159, 103, 0.22), transparent 34%), radial-gradient(circle at top right, rgba(116, 198, 221, 0.18), transparent 28%), linear-gradient(160deg, #03101A 0%, #07121D 46%, #0E1B28 100%)',
      },
      animation: {
        pulseLine: 'pulseLine 1.4s ease-in-out infinite',
        shimmer: 'shimmer 1.5s ease-in-out infinite',
      },
      keyframes: {
        pulseLine: {
          '0%, 100%': { opacity: 0.35 },
          '50%': { opacity: 1 },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
      },
    },
  },
  plugins: [],
};
