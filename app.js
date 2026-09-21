/*
 * app.js
 * ------
 * DOM/rendering + interaction layer. This file owns:
 *   - building the SVG graph once (nodes stay at the fixed positions
 *     given in the spec; only *state* re-renders on every step)
 *   - a single `renderStep(index)` function that is the ONE place all
 *     UI pieces (graph, description, table, slider, buttons) are kept
 *     in sync from - Back / Next / Reset / the slider / Play all just
 *     compute the next index and call renderStep(), so there is no way
 *     for the controls to drift out of sync with each other.
 *
 * All algorithm state (distances, predecessors, visited set) comes from
 * dijkstra.js's computeFrames(); all path geometry comes from
 * routing.js's buildAllPaths(). This file never invents a distance or a
 * route on its own - it only displays what those two files computed.
 */

(function () {
  'use strict';

  var NODE_R = 18;
  var NODE_ORDER = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    }
    return el;
  }

  // Cheap luminance check so each node's letter label is always legible
  // against that node's own fill color (dark text on light fills like
  // yellow/aqua/magenta, white text everywhere else).
  function textColorFor(hex) {
    var r = parseInt(hex.substr(1, 2), 16);
    var g = parseInt(hex.substr(3, 2), 16);
    var b = parseInt(hex.substr(5, 2), 16);
    var yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 150 ? '#0b0b0b' : '#ffffff';
  }

  var nodeCenters = NODE_ORDER.map(function (node) { return NODES[node]; });

  // Pick a point along edge a->b for its weight-label pill that avoids
  // sitting on top of any node circle. The graph layout is fixed, so a
  // handful of candidate positions along the edge (starting at the
  // midpoint, then nudging toward either end) checked once at build time
  // is enough - no need to redo this per frame.
  function findLabelPoint(a, b) {
    var candidates = [0.5, 0.62, 0.38, 0.72, 0.28, 0.8, 0.2];
    for (var c = 0; c < candidates.length; c++) {
      var t = candidates[c];
      var p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      var hitsNode = nodeCenters.some(function (n) {
        return Math.hypot(p.x - n.x, p.y - n.y) < NODE_R + 13;
      });
      if (!hitsNode) return p;
    }
    // Fallback: nothing was collision-free (shouldn't happen on this
    // layout) - just use the midpoint.
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // -------------------------------------------------------------
  // Build the static parts of the graph (base gray edges + node
  // circles/labels). These never move; only classes/text/path "d"
  // attributes change on each render.
  // -------------------------------------------------------------
  var svg = svgEl('svg', {
    viewBox: '0 0 660 430',
    role: 'img',
    'aria-label': 'Graph of nodes S through H with weighted edges',
  });
  document.getElementById('graph-container').appendChild(svg);

  var gEdgesBase = svgEl('g', { class: 'layer-edges-base' });
  var gPaths = svgEl('g', { class: 'layer-paths' });
  var gEdgeLabels = svgEl('g', { class: 'layer-edge-labels' });
  var gNodes = svgEl('g', { class: 'layer-nodes' });
  svg.appendChild(gEdgesBase);
  svg.appendChild(gPaths);
  // Weight-label pills are appended AFTER the colored route layer (but
  // still below the nodes) so a busy bundle of parallel lanes passing
  // directly over an edge's midpoint never blots out its weight label -
  // labels always stay legible on top of the lines.
  svg.appendChild(gEdgeLabels);
  svg.appendChild(gNodes);

  // Base graph edges, drawn once in a subtle neutral gray so the full
  // topology is always visible underneath whichever routes are colored.
  EDGES.forEach(function (edge) {
    var a = NODES[edge[0]], b = NODES[edge[1]], w = edge[2];
    gEdgesBase.appendChild(svgEl('line', {
      class: 'edge-base',
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
    }));

    // Weight label near the midpoint (nudged off-center only when the
    // midpoint would otherwise collide with a node circle - see
    // findLabelPoint), with a small pill behind it for legibility over
    // crossing/bundled lines.
    var labelPt = findLabelPoint(a, b);
    var labelGroup = svgEl('g', { class: 'edge-weight', transform: 'translate(' + labelPt.x + ',' + labelPt.y + ')' });
    labelGroup.appendChild(svgEl('rect', { x: -9, y: -8, width: 18, height: 16, rx: 4 }));
    var text = svgEl('text', { x: 0, y: 4, 'text-anchor': 'middle' });
    text.textContent = w;
    labelGroup.appendChild(text);
    gEdgeLabels.appendChild(labelGroup);
  });

  // One reusable <path> per destination (A..H) for its colored route.
  var routeEls = {};
  NODE_ORDER.forEach(function (node) {
    if (node === START_NODE) return;
    var el = svgEl('path', {
      class: 'route-path',
      id: 'route-' + node,
      fill: 'none',
      stroke: NODES[node].color,
    });
    gPaths.appendChild(el);
    routeEls[node] = el;
  });

  // Node circles + labels. (Distance values live only in the edge weight
  // labels and the stats table now - no per-node distance badge.)
  var nodeEls = {};
  NODE_ORDER.forEach(function (node) {
    var n = NODES[node];
    var g = svgEl('g', { class: 'node', 'data-node': node, transform: 'translate(' + n.x + ',' + n.y + ')' });

    var halo = svgEl('circle', { class: 'node-halo', r: NODE_R + 7 });
    var circle = svgEl('circle', { class: 'node-circle', r: NODE_R, fill: n.color });
    var label = svgEl('text', { class: 'node-label', y: 5, 'text-anchor': 'middle', fill: textColorFor(n.color) });
    label.textContent = node;

    g.appendChild(halo);
    g.appendChild(circle);
    g.appendChild(label);
    gNodes.appendChild(g);

    nodeEls[node] = { g: g };
  });

  // -------------------------------------------------------------
  // Stats table rows (built once, text content updated per render).
  // -------------------------------------------------------------
  var tbody = document.getElementById('stats-tbody');
  var tableCells = {};
  NODE_ORDER.forEach(function (node) {
    var tr = document.createElement('tr');
    tr.className = 'stats-row';

    var tdNode = document.createElement('td');
    var swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = NODES[node].color;
    tdNode.appendChild(swatch);
    tdNode.appendChild(document.createTextNode(node));

    var tdStatus = document.createElement('td');
    var tdDist = document.createElement('td');
    tdDist.className = 'num';
    var tdRoute = document.createElement('td');
    tdRoute.className = 'route-cell';

    tr.appendChild(tdNode);
    tr.appendChild(tdStatus);
    tr.appendChild(tdDist);
    tr.appendChild(tdRoute);
    tbody.appendChild(tr);

    tableCells[node] = { row: tr, status: tdStatus, dist: tdDist, route: tdRoute };
  });

  // -------------------------------------------------------------
  // Algorithm frames (the actual Dijkstra run) + control elements.
  // -------------------------------------------------------------
  var frames = computeFrames(START_NODE);
  var currentIndex = 0;
  var playTimer = null;

  var elBadge = document.getElementById('frame-badge');
  var elCounter = document.getElementById('step-counter');
  var elDescription = document.getElementById('step-description');
  var elSlider = document.getElementById('step-slider');
  var btnBack = document.getElementById('btn-back');
  var btnNext = document.getElementById('btn-next');
  var btnReset = document.getElementById('btn-reset');
  var btnPlay = document.getElementById('btn-play');

  elSlider.max = String(frames.length - 1);

  var FRAME_BADGE_LABEL = {
    init: 'Init',
    visit: 'Visit',
    done: 'Done',
  };

  function stopPlay() {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      btnPlay.textContent = '▶ Play';
      btnPlay.setAttribute('aria-pressed', 'false');
    }
  }

  // ---------------------------------------------------------------
  // The single render function every control funnels through.
  // ---------------------------------------------------------------
  function renderStep(index) {
    currentIndex = Math.max(0, Math.min(frames.length - 1, index));
    var frame = frames[currentIndex];

    // --- description / badge / counter / slider -------------------
    elBadge.textContent = FRAME_BADGE_LABEL[frame.type] || frame.type;
    elBadge.className = 'frame-badge frame-badge--' + frame.type;
    elCounter.textContent = 'Step ' + (currentIndex + 1) + ' / ' + frames.length;
    elDescription.textContent = frame.description;
    elSlider.value = String(currentIndex);

    btnBack.disabled = currentIndex === 0;
    btnNext.disabled = currentIndex === frames.length - 1;
    if (currentIndex === frames.length - 1) stopPlay();

    // --- colored subway paths, derived fresh from this frame -------
    var allPaths = buildAllPaths(frame);
    Object.keys(routeEls).forEach(function (node) {
      var d = allPaths[node];
      var el = routeEls[node];
      if (d) {
        el.setAttribute('d', d);
        el.classList.add('is-visible');
      } else {
        el.classList.remove('is-visible');
      }
    });

    // --- node visual states -----------------------------------------
    NODE_ORDER.forEach(function (node) {
      var isCurrent = frame.processingNode === node;
      var isVisited = !!frame.visited[node];
      var isUnreached = frame.dist[node] === Infinity;
      var cls = ['node'];
      if (isCurrent) cls.push('is-current');
      if (isVisited) cls.push('is-visited');
      if (isUnreached) cls.push('is-unreached');
      nodeEls[node].g.setAttribute('class', cls.join(' '));
    });

    // --- stats table --------------------------------------------------
    NODE_ORDER.forEach(function (node) {
      var cells = tableCells[node];
      var isCurrent = frame.processingNode === node;
      var isVisited = !!frame.visited[node];
      var status = isCurrent ? 'Processing now' : (isVisited ? 'Visited ✓' : 'Unvisited');
      cells.status.textContent = status;
      cells.dist.textContent = frame.dist[node] === Infinity ? '∞' : String(frame.dist[node]);
      var path = pathTo(node, frame.dist, frame.prev);
      cells.route.textContent = path ? formatPath(path) : '—';
      cells.row.className = 'stats-row' + (isCurrent ? ' is-current' : '') + (isVisited ? ' is-visited' : '');
    });
  }

  // -------------------------------------------------------------
  // Controls - every handler just computes an index and re-renders.
  // -------------------------------------------------------------
  btnNext.addEventListener('click', function () { stopPlay(); renderStep(currentIndex + 1); });
  btnBack.addEventListener('click', function () { stopPlay(); renderStep(currentIndex - 1); });
  btnReset.addEventListener('click', function () { stopPlay(); renderStep(0); });
  elSlider.addEventListener('input', function () { stopPlay(); renderStep(Number(elSlider.value)); });

  btnPlay.addEventListener('click', function () {
    if (playTimer) {
      stopPlay();
      return;
    }
    if (currentIndex >= frames.length - 1) renderStep(0);
    btnPlay.textContent = '⏸ Pause';
    btnPlay.setAttribute('aria-pressed', 'true');
    playTimer = setInterval(function () {
      if (currentIndex >= frames.length - 1) { stopPlay(); return; }
      renderStep(currentIndex + 1);
    }, 2200); // each step is now a full node visit with a longer description, so give it more time to read
  });

  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.tagName === 'INPUT') return; // let the slider handle its own arrow keys
    if (e.key === 'ArrowRight') { stopPlay(); renderStep(currentIndex + 1); }
    else if (e.key === 'ArrowLeft') { stopPlay(); renderStep(currentIndex - 1); }
  });

  renderStep(0);
})();
