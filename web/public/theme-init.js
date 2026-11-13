// Apply the remembered theme before the first paint, so a light-theme user never sees a dark flash.
// Kept in sync with src/lib/theme.ts (storage key 'restream.theme').
try {
  var p = localStorage.getItem('restream.theme');
  if (p === 'light' || (p === 'system' && matchMedia('(prefers-color-scheme: light)').matches)) {
    document.documentElement.dataset.theme = 'light';
  }
} catch (e) { /* storage unavailable */ }
