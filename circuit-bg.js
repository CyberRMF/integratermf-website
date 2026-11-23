/* ═══ A greyscale image across the home page hero as one object, in sharp embossed relief under a faint cloth
 * weave (dark theme only). ═══ */
(function () {
  var hero = document.getElementById('hero-section');
  if (!hero) return;
  var canvas = document.createElement('canvas');
  canvas.className = 'hero-circuit';
  canvas.setAttribute('aria-hidden', 'true');
  hero.insertBefore(canvas, hero.firstChild);
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var COVER = 1.0;          /* image is "contained" in the hero, then scaled by this */
  var MAX_ALPHA = 0.2125;   /* scales the keyed luminance; the source is already very dark, so this stays subtle */
  var OFFSET = 1.2;         /* how far the shadow and highlight sit from the form, in CSS px */

  var img = new Image();
  var imgReady = false;
  img.onload = function () { imgReady = true; start(); };
  img.src = 'hero-texture.jpg';

  var spriteW = null;       /* white-tinted, luminance-as-alpha (black background keyed out) */
  var spriteB = null;       /* black-tinted version, for carving the relief shadow */
  var cloth = null;         /* feathered cloth-weave overlay sized to the draw rect */
  var rect = null;          /* where the image is drawn, in CSS px */
  var width = 0, height = 0, dpr = 1;
  var drawn = false;

  function isDark() { return document.documentElement.getAttribute('data-theme') !== 'light'; }

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Turn the image into a keyed greyscale sprite: RGB = tint (white or black), alpha = source luminance. The
   * photo's black surround becomes transparent, so the hero's own colour shows around the form (no rectangle). */
  function makeSprite(white) {
    var oc = document.createElement('canvas');
    oc.width = img.naturalWidth; oc.height = img.naturalHeight;
    var g = oc.getContext('2d');
    if (!g) return null;
    g.drawImage(img, 0, 0);
    var d, a;
    try { d = g.getImageData(0, 0, oc.width, oc.height); a = d.data; } catch (e) { return oc; }
    var v = white ? 255 : 0;
    for (var i = 0; i < a.length; i += 4) {
      var lum = (a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114) | 0;
      a[i] = a[i + 1] = a[i + 2] = v; a[i + 3] = lum;
    }
    g.putImageData(d, 0, 0);
    return oc;
  }

  /* A faint fabric weave, feathered to an oval so it blends into the hero. */
  function makeCloth(w, h) {
    var oc = document.createElement('canvas');
    oc.width = Math.max(1, Math.round(w)); oc.height = Math.max(1, Math.round(h));
    var c = oc.getContext('2d');
    if (!c) return null;
    var rand = rng(90125);
    c.strokeStyle = 'rgba(200,205,210,0.05)';
    c.lineWidth = 1;
    for (var x = 0; x < oc.width; x += 3) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, oc.height); c.stroke(); }
    for (var y = 0; y < oc.height; y += 3) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(oc.width, y + 0.5); c.stroke(); }
    var sp = c.createImageData(oc.width, oc.height), s = sp.data;   /* a little thread noise */
    for (var i = 0; i < s.length; i += 4) {
      if (rand() < 0.92) { s[i + 3] = 0; continue; }
      var v = rand() < 0.5 ? 210 : 40;
      s[i] = s[i + 1] = s[i + 2] = v; s[i + 3] = Math.floor(18 + rand() * 30);
    }
    c.putImageData(sp, 0, 0);
    c.globalCompositeOperation = 'destination-in';          /* feather to an oval */
    var rg = c.createRadialGradient(oc.width / 2, oc.height / 2, Math.min(oc.width, oc.height) * 0.15,
                                    oc.width / 2, oc.height / 2, Math.min(oc.width, oc.height) * 0.62);
    rg.addColorStop(0, 'rgba(0,0,0,1)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = rg; c.fillRect(0, 0, oc.width, oc.height);
    return oc;
  }

  function setup() {
    width = hero.clientWidth; height = hero.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var iw = img.naturalWidth, ih = img.naturalHeight;
    var s = Math.max(width / iw, height / ih) * COVER;   /* cover: fill the full hero width (crop overflow) */
    var dw = iw * s, dh = ih * s;
    rect = { x: (width - dw) / 2, y: (height - dh) / 2, w: dw, h: dh };
    spriteW = makeSprite(true);
    spriteB = makeSprite(false);
    cloth = makeCloth(dw, dh);
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!spriteW) return;
    var x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    var useFilter = 'filter' in ctx;

    /* bottom-right shadow groove first, so the form sits over it — black sprite darkens only where the eye is */
    ctx.globalCompositeOperation = 'source-over';
    if (spriteB) {
      if (useFilter) ctx.filter = 'blur(0.4px)';
      ctx.globalAlpha = 0.45;
      ctx.drawImage(spriteB, x + OFFSET, y + OFFSET, w, h);
      if (useFilter) ctx.filter = 'none';
    }

    /* base form */
    ctx.globalAlpha = MAX_ALPHA;
    ctx.drawImage(spriteW, x, y, w, h);

    /* top-left highlight ridge — additive */
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.075;
    ctx.drawImage(spriteW, x - OFFSET, y - OFFSET, w, h);

    ctx.globalCompositeOperation = 'source-over';
    if (cloth) {
      ctx.globalAlpha = 0.05;
      ctx.drawImage(cloth, x, y, w, h);
    }
    ctx.globalAlpha = 1;
  }

  function start() {
    if (drawn || !imgReady || !isDark()) return;
    drawn = true;
    setup();
    render();
  }

  new MutationObserver(start).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    if (!drawn || hero.clientWidth === width) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      setup();
      render();
    }, 200);
  });

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
