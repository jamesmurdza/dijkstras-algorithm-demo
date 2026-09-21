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

  var NODE_R = 12; // just big enough to fit a single bold letter
  var NODE_ORDER = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  // Geometry (local to the marker's own position - see currentMarkerGroup
  // below) for the small "currently visiting" marker floating above a
  // node: a solid upside-down triangle pointing straight down at it.
  var CHEVRON_HALF_W = 6.5; // half-width of the flat top edge
  var CHEVRON_TOP_Y = -(NODE_R + 18); // y of the flat top edge
  var CHEVRON_TIP_Y = -(NODE_R + 8); // y of the bottom point (closer to the node)

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

  // -------------------------------------------------------------
  // Smooth path-shape morphing: when a route's `d` changes because it
  // just relaxed to a better route (or - stepping Back - "unrelaxed"
  // back to a worse one), animate the line sweeping into its new shape
  // instead of snapping instantly.
  //
  // CSS `transition: d` only interpolates smoothly when the old and new
  // path data have the exact same sequence of command types (same number
  // of M/Q/L segments) - browsers fall back to an instant jump otherwise.
  // Our paths change hop count constantly (a 2-hop path can become a
  // 5-hop path in a single relax), so that structural match essentially
  // never holds here. Instead we resample BOTH shapes into the same
  // fixed number of points along their arc length - using the browser's
  // own getPointAtLength()/getTotalLength(), so it works on any mix of
  // curves and lines without us hand-rolling bezier math - then animate a
  // plain point-to-point interpolated polyline between them frame by
  // frame via requestAnimationFrame, and swap in the real, precise path
  // data the instant the animation lands.
  // -------------------------------------------------------------
  var MORPH_DURATION = 380; // ms - well under the 2200ms Play interval
  var MORPH_SAMPLES = 48;

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function samplePathPoints(el, n) {
    var len = el.getTotalLength();
    var pts = new Array(n + 1);
    for (var i = 0; i <= n; i++) {
      var p = el.getPointAtLength((i / n) * len);
      pts[i] = { x: p.x, y: p.y };
    }
    return pts;
  }

  function polylineD(fromPts, toPts, t) {
    var parts = new Array(fromPts.length);
    for (var i = 0; i < fromPts.length; i++) {
      var x = fromPts[i].x + (toPts[i].x - fromPts[i].x) * t;
      var y = fromPts[i].y + (toPts[i].y - fromPts[i].y) * t;
      parts[i] = (i === 0 ? 'M ' : 'L ') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return parts.join(' ');
  }

  function cancelMorph(el) {
    if (el.__morphFrame) {
      cancelAnimationFrame(el.__morphFrame);
      el.__morphFrame = null;
    }
  }

  // Animate `el`'s `d` from whatever is currently on screen to `targetD`.
  // Safe to call again mid-animation (e.g. the slider is being dragged,
  // or Play advances before the previous morph finished) - it cancels
  // the in-flight animation and restarts from whatever shape is CURRENTLY
  // rendered, so a burst of rapid steps never stacks animations or fights
  // over the element.
  function morphPathTo(el, targetD) {
    cancelMorph(el);
    cancelGrow(el); // a still-growing path has a stroke-dasharray set - clear it before we start moving `d` under it

    var fromD = el.getAttribute('d');
    var fromPts = samplePathPoints(el, MORPH_SAMPLES);
    el.setAttribute('d', targetD);
    var toPts = samplePathPoints(el, MORPH_SAMPLES);
    el.setAttribute('d', fromD); // back to the starting shape; the rAF loop below takes it from here

    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / MORPH_DURATION);
      el.setAttribute('d', polylineD(fromPts, toPts, easeOutCubic(t)));
      if (t < 1) {
        el.__morphFrame = requestAnimationFrame(step);
      } else {
        el.setAttribute('d', targetD); // land on the exact, precise geometry
        el.__morphFrame = null;
      }
    }
    el.__morphFrame = requestAnimationFrame(step);
  }

  // -------------------------------------------------------------
  // "Draw-on" reveal for a route's very first appearance: rather than
  // just fading in over its full final shape, the line grows outward
  // from S, tip-first, the way a subway line gets extended.
  //
  // The classic SVG technique: a path's stroke-dasharray/dashoffset can
  // describe "one dash exactly as long as the whole path, currently
  // slid completely out of view" (dasharray = dashoffset = total
  // length); animating dashoffset down to 0 slides that single dash back
  // into place, which reads as the line drawing itself from start to
  // end. This needs the path's REAL final `d` (with its actual curves)
  // set from the start - only the reveal window changes, not the shape
  // - so it stays exact the whole time, unlike the polyline morph above.
  // -------------------------------------------------------------
  var GROW_DURATION = 650; // ms - a bit slower than a morph; this is a fresh discovery, not a quick correction

  function cancelGrow(el) {
    if (el.__growFrame) {
      cancelAnimationFrame(el.__growFrame);
      el.__growFrame = null;
    }
    el.style.strokeDasharray = '';
    el.style.strokeDashoffset = '';
  }

  // Add `is-visible` (opacity: 1) without letting its normal 0.25s CSS
  // fade run - the draw-on effect is what should carry a first
  // appearance, not a simultaneous opacity fade fighting it for
  // attention. Transition is suppressed only for this one instant jump;
  // future opacity changes (e.g. fading back out) animate normally.
  function addVisibleInstant(el) {
    var prevTransition = el.style.transition;
    el.style.transition = 'none';
    el.classList.add('is-visible');
    el.getBoundingClientRect(); // force layout so the jump commits before the transition is restored
    el.style.transition = prevTransition;
  }

  function growPathFromStart(el, targetD) {
    cancelMorph(el);
    cancelGrow(el);

    el.setAttribute('d', targetD); // the real, final geometry throughout - only the reveal window animates
    var len = el.getTotalLength();
    el.style.strokeDasharray = String(len);
    el.style.strokeDashoffset = String(len); // fully hidden

    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / GROW_DURATION);
      el.style.strokeDashoffset = String(len * (1 - easeOutCubic(t)));
      if (t < 1) {
        el.__growFrame = requestAnimationFrame(step);
      } else {
        el.style.strokeDasharray = '';
        el.style.strokeDashoffset = '';
        el.__growFrame = null;
      }
    }
    el.__growFrame = requestAnimationFrame(step);
  }

  var nodeCenters = NODE_ORDER.map(function (node) { return NODES[node]; });

  // Every weight label placed so far, so a later edge's label can avoid
  // sitting on top of an earlier one too (see findLabelPoint below) -
  // two edges that happen to pass close to each other can otherwise get
  // their labels placed at nearly the same point independently.
  var placedLabelPoints = [];

  // Pick a point along edge a->b for its weight-label pill that avoids
  // sitting on top of any node circle OR any other edge's weight label
  // already placed. The graph layout is fixed, so a handful of candidate
  // positions along the edge (starting at the midpoint, then nudging
  // toward either end) checked once at build time is enough - no need to
  // redo this per frame.
  function findLabelPoint(a, b) {
    var candidates = [0.5, 0.62, 0.38, 0.72, 0.28, 0.8, 0.2];
    for (var c = 0; c < candidates.length; c++) {
      var t = candidates[c];
      var p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      var hitsNode = nodeCenters.some(function (n) {
        return Math.hypot(p.x - n.x, p.y - n.y) < NODE_R + 13;
      });
      var hitsLabel = placedLabelPoints.some(function (q) {
        return Math.hypot(p.x - q.x, p.y - q.y) < 26;
      });
      if (!hitsNode && !hitsLabel) {
        placedLabelPoints.push(p);
        return p;
      }
    }
    // Fallback: nothing was collision-free (shouldn't happen on this
    // layout) - just use the midpoint.
    var fallback = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    placedLabelPoints.push(fallback);
    return fallback;
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
  // Every edge starts dashed ("not part of the shortest-path tree yet");
  // renderStep() below adds `is-used` (solid) for whichever edges the
  // CURRENT frame's paths actually run through, straight from the same
  // `collectEdgeUsage` routing.js uses to lay out the colored lines.
  var edgeEls = {};
  EDGES.forEach(function (edge) {
    var a = NODES[edge[0]], b = NODES[edge[1]], w = edge[2];
    var lineEl = svgEl('line', {
      class: 'edge-base',
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
    });
    gEdgesBase.appendChild(lineEl);
    edgeEls[edgeKey(edge[0], edge[1])] = lineEl;

    // Weight label near the midpoint (nudged off-center only when the
    // midpoint would otherwise collide with a node circle or an already-
    // placed label - see findLabelPoint), with a small round bubble
    // behind it for legibility over crossing/bundled lines. Radius is
    // sized to comfortably fit the widest weight in this graph (two
    // digits, e.g. "20") without the text touching the edge of the circle.
    var labelPt = findLabelPoint(a, b);
    var labelGroup = svgEl('g', { class: 'edge-weight', transform: 'translate(' + labelPt.x + ',' + labelPt.y + ')' });
    labelGroup.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 9.5 }));
    var text = svgEl('text', { x: 0, y: 3, 'text-anchor': 'middle' });
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

    var circle = svgEl('circle', { class: 'node-circle', r: NODE_R, fill: n.color });
    var label = svgEl('text', { class: 'node-label', y: 4, 'text-anchor': 'middle', fill: textColorFor(n.color) });
    label.textContent = node;

    g.appendChild(circle);
    g.appendChild(label);
    gNodes.appendChild(g);

    nodeEls[node] = { g: g };
  });

  // Small "you are here" marker - a solid upside-down triangle pointing
  // straight down at whichever node is currently being visited. A SINGLE
  // shared element (not one per node) appended last so it always renders
  // on top of every node, and repositioned in renderStep() by sliding
  // currentMarkerGroup to the current node's coordinates - see the
  // `transition: transform` in styles.css, which is what makes it glide
  // from node to node instead of jumping. The bounce animation lives on
  // the inner path instead, so it can animate in place without fighting
  // the outer group's own position transition (an element can only have
  // one `transform`, animated or not, at a time).
  var currentMarkerGroup = svgEl('g', { class: 'current-marker' });
  var currentMarkerTriangle = svgEl('path', {
    class: 'current-chevron',
    d: 'M ' + -CHEVRON_HALF_W + ' ' + CHEVRON_TOP_Y +
      ' L ' + CHEVRON_HALF_W + ' ' + CHEVRON_TOP_Y +
      ' L 0 ' + CHEVRON_TIP_Y + ' Z',
  });
  currentMarkerGroup.appendChild(currentMarkerTriangle);
  gNodes.appendChild(currentMarkerGroup);
  var lastProcessingNode = null; // so renderStep() can tell "moved" apart from "just appeared"

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

  // The step-description and stats-table live in a sidebar docked next
  // to the canvas. It's closed by default (canvas-only UI); either
  // toggle button opens it showing that panel, and clicking the
  // already-active toggle closes it again. The underlying content of
  // both panels is still kept fully up to date on every render() call
  // regardless of whether the sidebar is open, so opening it always
  // shows the current step immediately.
  var drawer = document.getElementById('drawer');
  var drawerStepPanel = document.getElementById('drawer-step');
  var drawerTablePanel = document.getElementById('drawer-table');
  var btnToggleStep = document.getElementById('btn-toggle-step');
  var btnToggleTable = document.getElementById('btn-toggle-table');
  var drawerMode = null; // null | 'step' | 'table'

  function setDrawerMode(mode) {
    drawerMode = mode;
    drawer.hidden = mode === null;
    drawerStepPanel.classList.toggle('is-active', mode === 'step');
    drawerTablePanel.classList.toggle('is-active', mode === 'table');
    btnToggleStep.setAttribute('aria-pressed', String(mode === 'step'));
    btnToggleTable.setAttribute('aria-pressed', String(mode === 'table'));
  }

  btnToggleStep.addEventListener('click', function () {
    setDrawerMode(drawerMode === 'step' ? null : 'step');
  });
  btnToggleTable.addEventListener('click', function () {
    setDrawerMode(drawerMode === 'table' ? null : 'table');
  });

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
      btnPlay.textContent = '▶';
      btnPlay.setAttribute('aria-pressed', 'false');
      btnPlay.setAttribute('aria-label', 'Auto-play through the steps');
      btnPlay.title = 'Auto-play through the steps';
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
    // (collectEdgeUsage is the same routing.js helper buildAllPaths uses
    // internally - reusing it here keeps "which edges are solid" and
    // "which edges the colored lines run through" from ever disagreeing.)
    var edgeUsage = collectEdgeUsage(frame);
    var allPaths = buildAllPaths(frame);
    Object.keys(routeEls).forEach(function (node) {
      var d = allPaths[node];
      var el = routeEls[node];
      if (d) {
        var currentD = el.getAttribute('d');
        var wasVisible = el.classList.contains('is-visible');
        if (!wasVisible) {
          // First appearance: draw it growing outward from S instead of
          // just fading in over its full shape.
          addVisibleInstant(el);
          growPathFromStart(el, d);
        } else if (currentD && currentD !== d) {
          // Already on screen and its shape actually changed (relaxed to
          // a better route, or - going Back - unrelaxed to a worse one):
          // sweep into the new shape instead of snapping.
          morphPathTo(el, d);
        } else {
          // Shape is unchanged - nothing to animate.
          cancelMorph(el);
          cancelGrow(el);
          el.setAttribute('d', d);
        }
      } else {
        cancelMorph(el);
        cancelGrow(el);
        el.classList.remove('is-visible');
      }
    });

    // --- base edges: solid once part of the current shortest-path tree,
    // dashed while still untraversed -----------------------------------
    Object.keys(edgeEls).forEach(function (key) {
      edgeEls[key].classList.toggle('is-used', !!edgeUsage[key]);
    });

    // --- node visual states -----------------------------------------
    NODE_ORDER.forEach(function (node) {
      var isCurrent = frame.processingNode === node;
      var isVisited = !!frame.visited[node];
      var cls = ['node'];
      if (isCurrent) cls.push('is-current');
      if (isVisited) cls.push('is-visited');
      nodeEls[node].g.setAttribute('class', cls.join(' '));
    });

    // --- "currently visiting" marker ---------------------------------
    // Slide the single shared marker to whichever node is processingNode
    // this frame. When it's newly appearing (there was no current node
    // last render - e.g. just after Reset, or stepping off the 'init'/
    // 'done' bookend frames) it should just appear in place rather than
    // visibly flying in from wherever it was last parked, so that one
    // move happens with transitions switched off.
    if (frame.processingNode) {
      var mn = NODES[frame.processingNode];
      if (!lastProcessingNode) currentMarkerGroup.classList.add('is-jumping');
      currentMarkerGroup.style.transform = 'translate(' + mn.x + 'px, ' + mn.y + 'px)';
      currentMarkerGroup.classList.add('is-visible');
      if (!lastProcessingNode) {
        // Force layout so the position above is committed before
        // transitions are switched back on - otherwise the browser can
        // coalesce both changes and still animate the very first move.
        currentMarkerGroup.getBoundingClientRect();
        currentMarkerGroup.classList.remove('is-jumping');
      }
    } else {
      currentMarkerGroup.classList.remove('is-visible');
    }
    lastProcessingNode = frame.processingNode;

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
    btnPlay.textContent = '⏸';
    btnPlay.setAttribute('aria-pressed', 'true');
    btnPlay.setAttribute('aria-label', 'Pause auto-play');
    btnPlay.title = 'Pause auto-play';
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

  setDrawerMode(null);
  renderStep(0);
})();
