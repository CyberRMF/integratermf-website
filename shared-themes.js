/* ═══ Shared theme picker logic for all CyberRMF website pages ═══ */
var THEME_SWATCHES = {
  dark: 'linear-gradient(to right,#242426 50%,#3b82f6 50%)',
  light: 'linear-gradient(to right,#fff 50%,#3b82f6 50%)'
};
function setTheme(theme) {
  if (!THEME_SWATCHES[theme]) theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('site-theme', theme); } catch(e) {}
  var btn = document.getElementById('theme-picker-btn');
  if (btn) btn.style.background = THEME_SWATCHES[theme];
  var swatches = document.querySelectorAll('.theme-swatch');
  var ids = ['dark','light'];
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
  setTheme(saved);
})();
