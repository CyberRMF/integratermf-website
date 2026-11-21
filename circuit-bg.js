/* ═══ Faint circuit texture that grows across the home page hero from its bottom-left corner (dark theme only) ═══ */
(function () {
  var hero = document.getElementById('hero-section');
  if (!hero || !window.requestAnimationFrame) return;
  var canvas = document.createElement('canvas');
  canvas.className = 'hero-circuit';
  canvas.setAttribute('aria-hidden', 'true');
  hero.insertBefore(canvas, hero.firstChild);
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var CELL = 16;
  var TRACE = '#212124';
  var PAD = '#262629';
  var GROW_MS = 7000;
  var TRACE_PX_PER_MS = 0.14;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DIRS = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];

  var traces = [];
  var width = 0;
  var frame = 0;
  var startedAt = 0;
  var animated = false;

  function isDark() { return document.documentElement.getAttribute('data-theme') !== 'light'; }

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Random-walk traces on a grid: mostly straight runs with 45 and 90 degree bends, ending in a pad. */
  function build(w, h) {
    var rand = rng(1253);
    var cols = Math.ceil(w / CELL) + 1;
    var rows = Math.ceil(h / CELL) + 1;
    var used = new Uint8Array(cols * rows);
    var diag = new Uint8Array(cols * rows);
    var inside = function (x, y) { return x >= 0 && y >= 0 && x < cols && y < rows && !used[y * cols + x]; };
    /* A diagonal step may not cross another diagonal through the same 2x2 block of cells. */
    var free = function (x, y, d) {
      if (!inside(x + DIRS[d][0], y + DIRS[d][1])) return false;
      if (d % 2 === 0) return true;
      var dx = DIRS[d][0], dy = DIRS[d][1];
      return diag[Math.min(y, y + dy) * cols + Math.min(x, x + dx)] !== (dx === dy ? 2 : 1);
    };
    var markDiag = function (x, y, d) {
      if (d % 2 === 0) return;
      var dx = DIRS[d][0], dy = DIRS[d][1];
      diag[Math.min(y, y + dy) * cols + Math.min(x, x + dx)] = dx === dy ? 1 : 2;
    };
    var order = [];
    for (var i = 0; i < cols * rows; i++) order.push(i);
    for (var j = order.length - 1; j > 0; j--) { var k = Math.floor(rand() * (j + 1)); var tmp = order[j]; order[j] = order[k]; order[k] = tmp; }

    var out = [];
    var maxDist = Math.hypot(w, h);
    order.forEach(function (cell) {
      var x = cell % cols, y = Math.floor(cell / cols);
      if (used[cell] || rand() > 0.55) return;
      used[cell] = 1;
      var pts = [[x, y]];
      var dir = rand() < 0.75 ? Math.floor(rand() * 4) * 2 : Math.floor(rand() * 4) * 2 + 1;
      var target = 3 + Math.floor(rand() * 16);
      var run = 0;
      for (var steps = 0; steps < target; steps++) {
        if (run >= 2 && rand() < 0.22) dir = (dir + (rand() < 0.5 ? 1 : 7) * (rand() < 0.3 ? 2 : 1)) % 8;
        if (!free(x, y, dir)) {
          var turned = false;
          for (var t = 0; t < 3 && !turned; t++) {
            var d2 = (dir + [2, 6, 1][t]) % 8;
            if (free(x, y, d2)) { dir = d2; turned = true; }
          }
          if (!turned) break;
          run = 0;
        }
        markDiag(x, y, dir);
        x += DIRS[dir][0]; y += DIRS[dir][1]; run++;
        used[y * cols + x] = 1;
        var last = pts[pts.length - 1];
        var prev = pts.length > 1 ? pts[pts.length - 2] : null;
        if (prev && (last[0] - prev[0]) === (x - last[0]) && (last[1] - prev[1]) === (y - last[1])) pts[pts.length - 1] = [x, y];
        else pts.push([x, y]);
      }
      if (pts.length < 2) return;
      var px = pts.map(function (p) { return [p[0] * CELL + CELL / 2, p[1] * CELL + CELL / 2]; });
      var a = px[0], b = px[px.length - 1];
      if (Math.hypot(b[0], h - b[1]) < Math.hypot(a[0], h - a[1])) px.reverse();
      var segs = [];
      var total = 0;
      for (var s = 1; s < px.length; s++) { var len = Math.hypot(px[s][0] - px[s - 1][0], px[s][1] - px[s - 1][1]); segs.push(len); total += len; }
      var o = px[0];
      out.push({ pts: px, segs: segs, total: total, drawn: 0, start: (Math.hypot(o[0], h - o[1]) / maxDist) * GROW_MS + rand() * 400 });
    });
    return out;
  }

  function pad(p) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 2.4, 0, Math.PI * 2);
    ctx.strokeStyle = PAD;
    ctx.stroke();
  }

  /* Strokes the part of a trace between `from` and `to` pixels along it. */
  function stroke(tr, from, to) {
    var at = 0;
    ctx.beginPath();
    for (var i = 0; i < tr.segs.length && at < to; i++) {
      var a = tr.pts[i], b = tr.pts[i + 1], len = tr.segs[i];
      if (at + len > from) {
        var s = Math.max(0, from - at) / len, e = Math.min(len, to - at) / len;
        ctx.moveTo(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s);
        ctx.lineTo(a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e);
      }
      at += len;
    }
    ctx.strokeStyle = TRACE;
    ctx.stroke();
  }

  function setup() {
    var w = hero.clientWidth, h = hero.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    width = w;
    traces = build(w, h);
  }

  function drawAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    traces.forEach(function (tr) { stroke(tr, 0, tr.total); pad(tr.pts[0]); pad(tr.pts[tr.pts.length - 1]); tr.drawn = tr.total; });
  }

  function tick(now) {
    var elapsed = now - startedAt;
    var pending = false;
    traces.forEach(function (tr) {
      if (tr.drawn >= tr.total) return;
      pending = true;
      var t = elapsed - tr.start;
      if (t <= 0) return;
      if (tr.drawn === 0) pad(tr.pts[0]);
      var to = Math.min(tr.total, t * TRACE_PX_PER_MS);
      if (to > tr.drawn) { stroke(tr, tr.drawn, to); tr.drawn = to; }
      if (tr.drawn >= tr.total) pad(tr.pts[tr.pts.length - 1]);
    });
    frame = pending ? requestAnimationFrame(tick) : 0;
  }

  function start() {
    if (animated || !isDark()) return;
    animated = true;
    setup();
    if (reduceMotion) { drawAll(); return; }
    startedAt = performance.now();
    frame = requestAnimationFrame(tick);
  }

  new MutationObserver(start).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    if (!animated || hero.clientWidth === width) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      setup();
      drawAll();
    }, 200);
  });

  start();
})();
