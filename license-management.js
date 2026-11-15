/* ═══ License Management page (deactivate.html) ═══
 * Kept out of the page, with no inline onclick handlers, so the page's
 * Content-Security-Policy (vercel.json) can allow scripts from this site only.
 */

// Relative paths so the fetch inherits the same origin as the page.
// The apex "integratermf.com" 307-redirects to "www.integratermf.com", and
// browsers can't follow that hop during a CORS preflight — the fetch fails
// with "NetworkError". Relative URLs sidestep the whole problem.
var ACTIVATE_AIRGAP_ENDPOINT   = '/api/activate-airgap';
var DEACTIVATE_ENDPOINT        = '/api/deactivate';
var DEACTIVATE_AIRGAP_ENDPOINT = '/api/deactivate-airgap';

var GENERIC_ERROR = 'Something went wrong. Please try again or contact info@cyberrmf.com.';

function selectAction(action) {
  document.querySelectorAll('.action-card').forEach(function(c) { c.classList.remove('selected'); });
  document.querySelectorAll('.license-panel').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('card-' + action).classList.add('selected');
  document.getElementById('panel-' + action).classList.add('active');
}

function switchTab(panel, method, el) {
  var container = document.getElementById('panel-' + panel);
  container.querySelectorAll('.method-tab').forEach(function(t) { t.classList.remove('active'); });
  container.querySelectorAll('.method-panel').forEach(function(p) { p.classList.remove('active'); });
  el.classList.add('active');
  document.getElementById(panel + '-' + method).classList.add('active');
}

/* ── Nav, theme picker, cards and tabs (setTheme / toggleThemePicker come from shared-themes.js) ── */
document.getElementById('theme-picker-btn').addEventListener('click', toggleThemePicker);
document.querySelectorAll('[data-theme-choice]').forEach(function(b) {
  b.addEventListener('click', function() { setTheme(b.getAttribute('data-theme-choice')); });
});
document.getElementById('nav-hamburger').addEventListener('click', function() {
  document.getElementById('mobile-menu').classList.toggle('open');
});
document.querySelectorAll('.action-card[data-action]').forEach(function(card) {
  card.addEventListener('click', function() { selectAction(card.getAttribute('data-action')); });
});
document.querySelectorAll('.method-tab[data-panel]').forEach(function(tab) {
  tab.addEventListener('click', function() {
    switchTab(tab.getAttribute('data-panel'), tab.getAttribute('data-method'), tab);
  });
});
document.getElementById('link-airgap-deact').addEventListener('click', function(e) {
  e.preventDefault();
  switchTab('deactivate', 'airgap', document.querySelectorAll('#panel-deactivate .method-tab')[1]);
});

/* ── Which app the license is for. Each app has its own licenses, and a response code only works in the app it was made for. ── */
var APP_NAMES = { 'integrate': 'CyberRMF Integrate', 'admin-tools': 'CyberRMF Admin Tools' };
var selectedApp = null;

function selectApp(app) {
  if (!APP_NAMES[app]) return;
  selectedApp = app;
  document.querySelectorAll('.app-choice').forEach(function(b) {
    var on = b.getAttribute('data-app') === app;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
document.querySelectorAll('.app-choice').forEach(function(b) {
  b.addEventListener('click', function() { selectApp(b.getAttribute('data-app')); });
});

function requireApp(showResult) {
  if (selectedApp) return true;
  showResult('err', 'Choose CyberRMF Integrate or CyberRMF Admin Tools at the top of the page.');
  document.querySelector('.app-choice').focus();
  return false;
}

/* ── "i" bubbles: hover or keyboard focus shows them; a click or tap keeps one open. ── */
function closeTips(except) {
  document.querySelectorAll('.info-tip[aria-expanded="true"]').forEach(function(t) {
    if (t !== except) t.setAttribute('aria-expanded', 'false');
  });
}
document.querySelectorAll('.info-tip').forEach(function(tip) {
  tip.addEventListener('click', function(e) {
    e.stopPropagation();
    closeTips(tip);
    tip.setAttribute('aria-expanded', tip.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
  });
});
document.addEventListener('click', function() { closeTips(null); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeTips(null); });

/*
 * Deep-link support so the welcome email (and the app's activation
 * screen) can drop the user directly on the right form.
 *
 *   /deactivate.html?action=activate                — Activate License card
 *   /deactivate.html?action=activate&mode=airgap    — Activate → Air-Gapped tab
 *   /deactivate.html?action=deactivate&mode=airgap  — Deactivate → Air-Gapped tab
 *   /deactivate.html?action=activate&mode=online    — Activate → Online tab
 *   &app=integrate or &app=admin-tools              — also picks the application
 */
(function applyUrlIntent() {
  try {
    var params = new URLSearchParams(window.location.search);
    selectApp((params.get('app') || '').toLowerCase());
    var action = (params.get('action') || '').toLowerCase();
    var mode   = (params.get('mode')   || '').toLowerCase();
    var validActions = { activate: 1, deactivate: 1 };
    var validModes   = { online: 1, airgap: 1 };
    if (!validActions[action]) return;
    selectAction(action);
    if (!validModes[mode]) return;
    var container = document.getElementById('panel-' + action);
    if (!container) return;
    var tabs = container.querySelectorAll('.method-tab');
    // First tab is online, second is airgap — matches the DOM order.
    var idx = (mode === 'airgap') ? 1 : 0;
    var tab = tabs[idx];
    if (tab) switchTab(action, mode, tab);
    // Scroll the panel into view so the user isn't confused by the hero at top.
    setTimeout(function() {
      var target = document.getElementById(action + '-' + mode);
      if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  } catch (e) { /* ignore */ }
})();

function fieldValue(id) {
  return document.getElementById(id).value.trim();
}

/*
 * Two-step form (Online Deactivation).
 * The first submit sends the details; the server checks them and emails a
 * confirmation code to the address on the license. The second step sends
 * the same details plus the code, and the server does the work.
 *
 * Element ids, from opts.prefix: -btn (first submit), -confirm (code box),
 * -sent, -otp (code input), -confirm-btn, -resend, -back, -result.
 */
function setupConfirmForm(opts) {
  var form       = document.getElementById(opts.form);
  var sendBtn    = document.getElementById(opts.prefix + '-btn');
  var box        = document.getElementById(opts.prefix + '-confirm');
  var sentText   = document.getElementById(opts.prefix + '-sent');
  var codeInput  = document.getElementById(opts.prefix + '-otp');
  var confirmBtn = document.getElementById(opts.prefix + '-confirm-btn');
  var resendBtn  = document.getElementById(opts.prefix + '-resend');
  var backBtn    = document.getElementById(opts.prefix + '-back');
  var result     = document.getElementById(opts.prefix + '-result');
  var fields     = form.querySelectorAll('input:not(.code-input)');
  var sendLabel    = sendBtn.textContent;
  var confirmLabel = confirmBtn.textContent;
  var token = null;
  var busy = false;
  var timer = null;

  function showResult(kind, text) {
    result.className = 'result-msg ' + kind;
    result.textContent = text;
    result.style.display = 'block';
  }
  function hideResult() { result.style.display = 'none'; }

  // While a code is pending the details are locked, so the code always
  // matches what is on the screen. Back unlocks them.
  function lock(on) {
    fields.forEach(function(f) { f.readOnly = on; });
    sendBtn.style.display = on ? 'none' : 'block';
    box.style.display = on ? 'block' : 'none';
  }

  function enableResend() {
    clearInterval(timer);
    resendBtn.disabled = false;
    resendBtn.textContent = 'Send a new code';
  }
  function startCooldown(seconds) {
    var left = seconds;
    clearInterval(timer);
    resendBtn.disabled = true;
    function tick() {
      if (left <= 0) { enableResend(); return; }
      resendBtn.textContent = 'Send a new code (' + left + ' s)';
      left -= 1;
    }
    tick();
    timer = setInterval(tick, 1000);
  }

  function reset() {
    token = null;
    clearInterval(timer);
    codeInput.value = '';
    lock(false);
  }

  async function post(extra) {
    var body = opts.body();
    for (var k in extra) body[k] = extra[k];
    var resp = await fetch(opts.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var json = await resp.json().catch(function() { return {}; });
    if (resp.status === 429 && !json.error) json.error = 'Too many attempts. Please wait a few minutes and try again.';
    return { resp: resp, json: json };
  }

  async function sendCode(again) {
    if (busy) return;
    if (!again && opts.askFirst && !window.confirm(opts.askFirst)) return;
    busy = true;
    var btn = again ? resendBtn : sendBtn;
    btn.disabled = true;
    btn.textContent = 'Sending\u2026';
    hideResult();
    try {
      var r = await post({});
      if (!r.resp.ok || !r.json.confirmToken) throw new Error(r.json.error || GENERIC_ERROR);
      token = r.json.confirmToken;
      sentText.textContent = again
        ? 'We sent a new code to ' + r.json.sentTo + '. Use the code in the newest email.'
        : 'We sent a code to ' + r.json.sentTo + '. Enter it below.';
      codeInput.value = '';
      lock(true);
      startCooldown(r.json.resendAfterSeconds || 60);
      codeInput.focus();
    } catch (err) {
      showResult('err', err.message || GENERIC_ERROR);
      if (again) enableResend();
    }
    sendBtn.disabled = false;
    sendBtn.textContent = sendLabel;
    busy = false;
  }

  async function confirmCode() {
    if (busy || !token) return;
    var code = codeInput.value.replace(/[^0-9A-Za-z]/g, '');
    if (code.length !== 8) {
      showResult('err', 'The code has 8 letters and numbers, like ABCD-EFGH.');
      codeInput.focus();
      return;
    }
    busy = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Processing\u2026';
    hideResult();
    try {
      var r = await post({ confirmToken: token, confirmCode: code });
      if (!r.resp.ok) {
        if (r.resp.status === 410) enableResend();
        throw new Error(r.json.error || GENERIC_ERROR);
      }
      reset();
      opts.onDone(r.json, showResult);
    } catch (err) {
      showResult('err', err.message || GENERIC_ERROR);
    }
    confirmBtn.disabled = false;
    confirmBtn.textContent = confirmLabel;
    busy = false;
  }

  // Accepts the code typed or pasted with or without the dash, in any case.
  codeInput.addEventListener('input', function() {
    var clean = codeInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
    var shown = clean.length > 4 ? clean.slice(0, 4) + '-' + clean.slice(4) : clean;
    if (shown !== codeInput.value) codeInput.value = shown;
  });
  codeInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); confirmCode(); }
  });
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    if (token) confirmCode(); else if (requireApp(showResult)) sendCode(false);
  });
  confirmBtn.addEventListener('click', confirmCode);
  resendBtn.addEventListener('click', function() { sendCode(true); });
  backBtn.addEventListener('click', function() {
    reset();
    hideResult();
    fields[0].focus();
  });
}

/* Air-Gapped Activation: one request. The server emails the response code to the address on the license; it never comes back to the page. */
async function handleActAirgap(e) {
  e.preventDefault();
  var btn = document.getElementById('act-ag-btn');
  var res = document.getElementById('act-ag-result');
  function showResult(kind, text) {
    res.className = 'result-msg ' + kind;
    res.textContent = text;
    res.style.display = 'block';
  }
  if (!requireApp(showResult)) return;
  btn.disabled = true;
  btn.textContent = 'Sending\u2026';
  res.style.display = 'none';

  try {
    var resp = await fetch(ACTIVATE_AIRGAP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: selectedApp,
        key: fieldValue('act-ag-key'),
        email: fieldValue('act-ag-email'),
        activationCode: fieldValue('act-ag-code').toUpperCase()
      })
    });
    var json = await resp.json().catch(function() { return {}; });
    if (resp.status === 429 && !json.error) json.error = 'Too many attempts. Please wait a few minutes and try again.';
    if (!resp.ok) throw new Error(json.error || GENERIC_ERROR);
    showResult('ok', json.message || ('We emailed your response code to ' + (json.sentTo || 'the address on the license') +
      '. Enter it in the app on the air-gapped machine. It can take a few minutes; check your spam folder.'));
  } catch (err) {
    showResult('err', err.message || GENERIC_ERROR);
  }
  btn.disabled = false;
  btn.textContent = 'Email My Response Code';
}
document.getElementById('activate-airgap-form').addEventListener('submit', handleActAirgap);

setupConfirmForm({
  form: 'deact-online-form',
  prefix: 'deact-ol',
  endpoint: DEACTIVATE_ENDPOINT,
  // Second-chance confirmation — this really does release every machine
  // currently tied to the key, and the wording "3 slots released" surprises
  // users who assumed it was per-machine.
  askFirst:
    'This releases EVERY machine currently activated on this license key ' +
    '(you may have more than one — every install will need to re-activate).\n\n' +
    'To release just one specific machine, cancel this and either:\n' +
    '  1) Use the app\u2019s License Management \u2192 Deactivate License \u2192 Online \u2192 Deactivate This Machine, or\n' +
    '  2) Use this page\u2019s Air-Gapped Deactivation tab with a code from that machine.\n\n' +
    'Continue? We will email you a code. Nothing is released until you enter it.',
  body: function() {
    return {
      product: selectedApp,
      key: fieldValue('deact-ol-key'),
      email: fieldValue('deact-ol-email')
    };
  },
  onDone: function(json, showResult) {
    showResult('ok', json.message || ('License deactivated successfully. ' + (json.machinesRemoved || 0) + ' machine slot(s) released. You can now activate on your new machine.'));
  }
});

async function handleDeactAirgap(e) {
  e.preventDefault();
  var btn = document.getElementById('deact-ag-btn');
  var res = document.getElementById('deact-ag-result');
  if (!requireApp(function(kind, text) {
    res.className = 'result-msg ' + kind;
    res.textContent = text;
    res.style.display = 'block';
  })) return;
  btn.disabled = true;
  btn.textContent = 'Processing\u2026';
  res.style.display = 'none';

  try {
    var resp = await fetch(DEACTIVATE_AIRGAP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: selectedApp,
        key: fieldValue('deact-ag-key'),
        email: fieldValue('deact-ag-email'),
        deactivationCode: fieldValue('deact-ag-code').toUpperCase()
      })
    });
    var json = await resp.json().catch(function() { return {}; });
    if (resp.status === 429 && !json.error) json.error = 'Too many attempts. Please wait a few minutes and try again.';
    if (!resp.ok) throw new Error(json.error || 'Verification failed');
    res.className = 'result-msg ok';
    res.textContent = json.message || 'Machine released successfully. Your license key can now be activated on a new machine.';
    res.style.display = 'block';
  } catch (err) {
    res.className = 'result-msg err';
    res.textContent = err.message || GENERIC_ERROR;
    res.style.display = 'block';
  }
  btn.disabled = false;
  btn.textContent = 'Submit Deactivation Code';
}
document.getElementById('deact-airgap-form').addEventListener('submit', handleDeactAirgap);
