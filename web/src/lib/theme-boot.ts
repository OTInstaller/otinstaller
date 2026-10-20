// Runs inline in <head> before the first paint: applies the saved theme (so there is no flash) and marks the
// document as having JavaScript (so reveal animations may hide content until it scrolls into view).
// The string is hashed in astro.config.mjs for the Content-Security-Policy, so it must stay byte-identical.
export const THEME_BOOT =
  '(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}document.documentElement.classList.add("js")})();';
