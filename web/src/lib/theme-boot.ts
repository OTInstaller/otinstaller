// Runs inline in <head> before the first paint: applies the saved theme so there is no flash. Dark is the default
// (no attribute); "light" and "system" are the saved choices. No content is ever hidden waiting for this script.
// The string is hashed in astro.config.mjs for the Content-Security-Policy, so it must stay byte-identical.
export const THEME_BOOT =
  '(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="system"){document.documentElement.dataset.theme=t}}catch(e){}})();';
