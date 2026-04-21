/* ═══ Shared theme picker logic for all CyberRMF website pages ═══ */
var THEME_SWATCHES = {
  cyber: 'linear-gradient(to right,#111 50%,#2563eb 50%)',
  dark: 'linear-gradient(to right,#242426 50%,#3b82f6 50%)',
  mono: 'linear-gradient(to right,#000 50%,#fff 50%)',
  'dark-green': 'linear-gradient(to right,#000 50%,#4a8a4a 50%)',
  light: 'linear-gradient(to right,#fff 50%,#3b82f6 50%)'
};
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('site-theme', theme); } catch(e) {}
  var btn = document.getElementById('theme-picker-btn');
  if (btn) btn.style.background = THEME_SWATCHES[theme] || THEME_SWATCHES.cyber;
  var swatches = document.querySelectorAll('.theme-swatch');
  var ids = ['cyber','dark','mono','dark-green','light'];
  swatches.forEach(function(s, i) {
    s.classList.toggle('current', ids[i] === theme);
  });
  var dd = document.getElementById('theme-dropdown');
  if (dd) dd.classList.remove('open');
}
function toggleThemePicker() {
  var dd = document.getElementById('theme-dropdown');
  if (dd) dd.classList.toggle('open');
}
document.addEventListener('click', function(e) {
  var wrap = document.getElementById('theme-picker-wrap');
  if (wrap && !wrap.contains(e.target)) {
    var dd = document.getElementById('theme-dropdown');
    if (dd) dd.classList.remove('open');
  }
});
(function() {
  var saved;
  try { saved = localStorage.getItem('site-theme'); } catch(e) {}
  if (saved === 'blue' || saved === 'midnight') saved = 'cyber';
  setTheme(saved || 'dark');
})();
