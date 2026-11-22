/* ═══ Faint embossed neuron texture that grows across the home page hero from its bottom-left corner (dark theme only) ═══ */
(function () {
  var hero = document.getElementById('hero-section');
  if (!hero || !window.requestAnimationFrame || !window.Path2D) return;
  var canvas = document.createElement('canvas');
  canvas.className = 'hero-circuit';
  canvas.setAttribute('aria-hidden', 'true');
  hero.insertBefore(canvas, hero.firstChild);
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var STEP = 2;
  var GAP = 4;
  var CELL = 2;
  var YOUNG = 5;
  var BRANCH = 0.06;
  var SPUR = 0.07;
  var MIN_W = 0.45;
  var MAX_W = 1.8;
  var GROW_MS = 8000;
  var BUCKETS = 16;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var net = null;
  var colors = null;
  var width = 0;
  var frame = 0;
  var startedAt = 0;
  var stepMs = 1;
  var drawn = 0;
  var animated = false;
  var grain = null;

  function isDark() { return document.documentElement.getAttribute('data-theme') !== 'light'; }

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* The ridges are the hero's own color, lit from the top left: a lighter edge above, a darker one below. */
  function heroColors() {
    var m = getComputedStyle(hero).backgroundColor.match(/\d+(\.\d+)?/g);
    var rgb = m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : [26, 26, 28];
    var shade = function (d) { return 'rgb(' + rgb.map(function (c) { return Math.max(0, Math.min(255, Math.round(c + d))); }).join(',') + ')'; };
    return { body: shade(0), light: shade(9), shadow: shade(-10) };
  }

  /* A sparse grain tile, inked in the hero's own light/shadow shades, tiled and stroked along the ridges so the
   * neurons read as grainy rather than smooth. Mostly transparent so it stipples instead of flooding. */
  function makeGrain(c) {
    var size = 128;
    var oc = document.createElement('canvas');
    oc.width = size; oc.height = size;
    var octx = oc.getContext('2d');
    if (!octx) return null;
    var img = octx.createImageData(size, size);
    var rand = rng(1699);
    var lm = c.light.match(/\d+(\.\d+)?/g) || [255, 255, 255];
    var sm = c.shadow.match(/\d+(\.\d+)?/g) || [0, 0, 0];
    for (var i = 0; i < img.data.length; i += 4) {
      if (rand() < 0.74) { img.data[i + 3] = 0; continue; } /* mostly bare -> sparse speckle */
      var src = rand() < 0.5 ? sm : lm;
      img.data[i] = +src[0]; img.data[i + 1] = +src[1]; img.data[i + 2] = +src[2];
      img.data[i + 3] = Math.floor(70 + rand() * 120);
    }
    octx.putImageData(img, 0, 0);
    return ctx.createPattern(oc, 'repeat');
  }

  /*
   * Branches wander and fork like dendrites, growing out from the bottom-left corner. A branch stops where it would
   * come within GAP px of any other branch; only its own last few steps (and its fork's) don't count. Once every
   * branch has stopped, side shoots grow into the gaps that are left. Each piece is then as thick as the number of
   * branch ends it carries, so the arbor thins out at every fork.
   */
  function build(w, h) {
    var rand = rng(1253);
    var cap = Math.ceil((w + 16) * (h + 16) / (GAP * STEP) * 1.6) + 4000;
    var X = new Float32Array(cap), Y = new Float32Array(cap), W = new Float32Array(cap);
    var T = new Int32Array(cap), B = new Int32Array(cap), P = new Int32Array(cap), BR = new Int32Array(cap);
    var forkOf = new Int32Array(cap), next = new Int32Array(cap);
    var n = 0, step = 0, branches = 0;
    var R = Math.ceil(GAP / CELL);
    var M = R + 8;
    var cols = Math.ceil(w / CELL) + 2 * M, rows = Math.ceil(h / CELL) + 2 * M;
    var head = new Int32Array(cols * rows);
    var gap2 = GAP * GAP;
    var TURNS = [0, 0.35, -0.35, 0.7, -0.7];

    function branch(parent) {
      forkOf[branches] = parent;
      return branches++;
    }

    /* Whether the line from (ax, ay) to (bx, by) crosses the piece leading into node k. */
    function crosses(ax, ay, bx, by, k) {
      var p = P[k];
      if (p < 0) return false;
      var cx = X[p], cy = Y[p], dx = X[k], dy = Y[k];
      var d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      var d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
      var d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
      var d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
      return d1 * d2 < 0 && d3 * d4 < 0;
    }

    /*
     * Whether branch `id` may grow from (x0, y0) to (x, y). Its own and its fork's newest pieces may be closer than
     * GAP, as long as it doesn't cross them.
     */
    function free(x0, y0, x, y, id) {
      if (x < -8 || y < -8 || x > w + 8 || y > h + 8) return false;
      var cx = Math.floor(x / CELL) + M, cy = Math.floor(y / CELL) + M;
      for (var j = -R; j <= R; j++) {
        var row = (cy + j) * cols + cx;
        for (var i = -R; i <= R; i++) {
          for (var k = head[row + i] - 1; k >= 0; k = next[k] - 1) {
            var dx = X[k] - x, dy = Y[k] - y;
            if (dx * dx + dy * dy >= gap2) continue;
            var b = BR[k];
            if (B[k] > step - YOUNG && (b === id || b === forkOf[id] || forkOf[b] === id) && !crosses(x0, y0, x, y, k)) continue;
            return false;
          }
        }
      }
      return true;
    }

    /* Whether the line from (ax, ay) to (bx, by) crosses nothing. */
    function clear(ax, ay, bx, by) {
      var r = Math.ceil((Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) / 2 + STEP) / CELL);
      var cx = Math.floor((ax + bx) / 2 / CELL) + M, cy = Math.floor((ay + by) / 2 / CELL) + M;
      for (var j = -r; j <= r; j++) {
        for (var i = -r; i <= r; i++) {
          for (var k = head[(cy + j) * cols + cx + i] - 1; k >= 0; k = next[k] - 1) {
            if (crosses(ax, ay, bx, by, k)) return false;
          }
        }
      }
      return true;
    }

    function add(x, y, parent, id) {
      if (n >= cap) return -1;
      X[n] = x; Y[n] = y; P[n] = parent; B[n] = step; BR[n] = id;
      T[n] = parent < 0 ? 0 : T[parent] + 1;
      var c = (Math.floor(y / CELL) + M) * cols + Math.floor(x / CELL) + M;
      next[n] = head[c];
      head[c] = n + 1;
      return n++;
    }

    function advance(t) {
      var x0 = X[t.node], y0 = Y[t.node];
      var d = Math.atan2(y0 - h, x0) - t.heading;
      t.av = t.av * 0.85 + (rand() - 0.5) * 0.12;
      t.heading += t.av + Math.atan2(Math.sin(d), Math.cos(d)) * 0.006;
      var flip = rand() < 0.5 ? 1 : -1;
      for (var i = 0; i < TURNS.length; i++) {
        var a = t.heading + TURNS[i] * flip;
        var x = x0 + Math.cos(a) * STEP, y = y0 + Math.sin(a) * STEP;
        if (!free(x0, y0, x, y, t.id)) continue;
        var k = add(x, y, t.node, t.id);
        if (k < 0) return false;
        t.node = k;
        t.heading = a;
        return true;
      }
      return false;
    }

    /* A branch either forks in two, both halves turned apart, or puts out a side branch or a short spur. */
    function grow(tips) {
      while (tips.length) {
        step++;
        var next = [];
        for (var i = 0; i < tips.length; i++) {
          var t = tips[i];
          if (t.life === 0 || !advance(t)) continue;
          if (t.life > 0) t.life--;
          next.push(t);
          if (t.life >= 0 || branches >= cap) continue;
          var side = rand() < 0.5 ? 1 : -1;
          var r = rand();
          if (r < BRANCH * 0.5) {
            var half = 0.3 + rand() * 0.25;
            next.push({ node: t.node, id: branch(t.id), heading: t.heading - side * half, av: 0, life: -1 });
            t.heading += side * half;
          } else if (r < BRANCH) {
            next.push({ node: t.node, id: branch(t.id), heading: t.heading + side * (0.6 + rand() * 0.5), av: 0, life: -1 });
          } else if (r < BRANCH + SPUR) {
            next.push({ node: t.node, id: branch(t.id), heading: t.heading + side * (0.7 + rand() * 0.6), av: 0, life: 2 + Math.floor(rand() * 6) });
          }
        }
        tips = next;
      }
    }

    var roots = [[3, h - 3, -0.72], [0, h - 12, -0.3], [0, h - 40, -0.24], [0, h - 72, -0.16], [12, h, -1.15], [40, h, -1.28], [72, h, -1.38]];
    grow(roots.map(function (r) { var id = branch(-1); return { node: add(r[0], r[1], -1, id), id: id, heading: r[2], av: 0, life: -1 }; }));
    var mainSteps = Math.max(1, step);

    var grown = n;
    var reach = GAP * 1.3;
    for (var s = 0; s < grown && n < cap; s++) {
      var i = Math.floor(rand() * grown);
      var p = P[i];
      if (p < 0) continue;
      var a = Math.atan2(Y[i] - Y[p], X[i] - X[p]) + (rand() < 0.5 ? 1 : -1) * (1 + rand() * 0.5);
      var x = X[i] + Math.cos(a) * reach, y = Y[i] + Math.sin(a) * reach;
      step += YOUNG + 1;
      if (branches >= cap || !free(X[i], Y[i], x, y, -1) || !clear(X[i], Y[i], x, y)) continue;
      var id = branch(BR[i]);
      var k = i;
      for (var j = 1; j <= 3 && k >= 0; j++) k = add(X[i] + (x - X[i]) * j / 3, Y[i] + (y - Y[i]) * j / 3, k, id);
      if (k >= 0) grow([{ node: k, id: id, heading: a, av: 0, life: -1 }]);
    }

    var q;
    for (q = n - 1; q >= 0; q--) {
      if (W[q] === 0) W[q] = 1;
      if (P[q] >= 0) W[P[q]] += W[q];
    }
    for (q = 0; q < n; q++) W[q] = Math.min(MAX_W, MIN_W + 0.12 * Math.pow(W[q], 0.45));

    /* Nodes in the order they appear: by steps from their root. */
    var maxT = 0;
    for (q = 0; q < n; q++) if (T[q] > maxT) maxT = T[q];
    var start = new Int32Array(maxT + 2);
    for (q = 0; q < n; q++) start[T[q] + 1]++;
    for (q = 1; q <= maxT + 1; q++) start[q] += start[q - 1];
    var order = new Int32Array(n);
    for (q = 0; q < n; q++) order[start[T[q]]++] = q;

    return { X: X, Y: Y, W: W, T: T, P: P, n: n, order: order, mainSteps: mainSteps };
  }

  /* One color of the ridges between nodes order[a] and order[b - 1], grouped by width so each width is one stroke. */
  function layer(color, ox, oy, extra, a, b, withParents) {
    var paths = [];
    var X = net.X, Y = net.Y, W = net.W, P = net.P;
    function seg(k) {
      var p = P[k];
      if (p < 0) return;
      var q = Math.max(1, Math.min(BUCKETS - 1, Math.round((W[k] + extra) * 4)));
      var path = paths[q] || (paths[q] = new Path2D());
      path.moveTo(X[p] + ox, Y[p] + oy);
      path.lineTo(X[k] + ox, Y[k] + oy);
    }
    for (var i = a; i < b; i++) {
      var k = net.order[i];
      seg(k);
      if (withParents && P[k] >= 0) seg(P[k]);
    }
    ctx.strokeStyle = color;
    for (var q = 1; q < paths.length; q++) {
      if (!paths[q]) continue;
      ctx.lineWidth = q / 4;
      ctx.stroke(paths[q]);
    }
  }

  /* The top of each new ridge is drawn over its parent's too, so the edges of a new piece never mark the one before it. */
  function strokeRange(a, b) {
    layer(colors.shadow, 0.55, 0.75, 0.7, a, b, false);
    layer(colors.light, -0.45, -0.6, 0.3, a, b, false);
    layer(colors.body, 0, 0, 0, a, b, true);
    if (grain) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      layer(grain, 0, 0, 0.5, a, b, true);
      ctx.restore();
    }
  }

  function setup() {
    var w = hero.clientWidth, h = hero.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    width = w;
    colors = heroColors();
    grain = makeGrain(colors);
    net = build(w, h);
    stepMs = GROW_MS / net.mainSteps;
    drawn = 0;
  }

  function drawAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokeRange(0, net.n);
    drawn = net.n;
  }

  function tick(now) {
    var reached = (now - startedAt) / stepMs;
    var b = drawn;
    while (b < net.n && net.T[net.order[b]] <= reached) b++;
    if (b > drawn) { strokeRange(drawn, b); drawn = b; }
    frame = drawn < net.n ? requestAnimationFrame(tick) : 0;
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

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
