// tailwind.config.js
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Remove the colors block below!
      // colors: {
      //   themeblue: '#1a4474',
      //   'themeblue-hover': '#0f2743',
      // },
    },
  },
  plugins: [],
}
