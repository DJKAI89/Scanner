// Dark theme. The app styles most things with inline colours, so instead of re-writing every
// component the whole page is inverted with a CSS filter and the content that must keep its real
// colours (charts, images, canvases, video) is inverted back. Colours stay readable; hues are kept
// by the hue rotation. Stored per device.
const KEY = 'scanner_theme';

export function getTheme() {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch (_) { return 'light'; }
}

export function applyTheme(mode) {
  try { localStorage.setItem(KEY, mode); } catch (_) { /* private mode */ }
  document.documentElement.classList.toggle('theme-dark', mode === 'dark');
}

// Call once at startup.
export function initTheme() { applyTheme(getTheme()); }
