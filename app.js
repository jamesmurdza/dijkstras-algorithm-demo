/*
 * app.js
 * ------
 * DOM/rendering + interaction layer. This file owns:
 *   - a scenario picker: the dropdown in the header lets you swap the
 *     active graph (see scenarios.js) at any time - loadScenario() tears
 *     down the current SVG graph/algorithm run and builds a fresh one
 *     from scratch for whichever scenario was picked. Everything BELOW
 *     that point in this file used to run exactly once, at load time;
 *     it's now just what loadScenario() does every time it runs.
 *   - a single `renderStep(index)` function (redefined fresh inside each
 *     loadScenario() call) that is the ONE place all UI pieces (graph,
 *     description, table, slider, buttons) are kept in sync from - Back
 *     / Next / Reset / the slider / Play all just compute the next index
 *     and call it, so there is no way for the controls to drift out of
 *     sync with each other.
 *   - the toolbar's buttons/slider/keyboard shortcuts are wired up ONCE,
 *     at the bottom of this file, calling into a small `app` object
 *     whose methods (next/back/reset/seek/playToggle/stopPlay) get
 *     reassigned by every loadScenario() call - that indirection is what
 *     lets the toolbar keep working across scenario switches without
 *     ever attaching a second, duplicate set of listeners to the same
 *     buttons.
 *
 * All algorithm state (distances, predecessors, visited set) comes from
 * dijkstra.js's computeFrames(); all path geometry comes from
 * routing.js's buildAllPaths(). This file never invents a distance or a
 * route on its own - it only displays what those two files computed for
 * whichever scenario (see scenarios.js) is currently active.
 */

(function () {
  'use strict';

  var NODE_R = 12; // just big enough to fit a single bold letter

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
  //
  // These helpers are all generic (they take the element/target shape as
  // arguments) so they stay defined once, shared by every scenario.
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

  // Standard "ease out back" curve (overshoots past 1 then settles) so a
  // released dragged node visibly springs past its real position and
  // gently rebounds into place, instead of just gliding straight to a
  // stop. Generic math, shared by every scenario.
  function easeOutBack(t) {
    var c1 = 1.70158, c3 = c1 + 1, p = t - 1;
    return 1 + c3 * p * p * p + c1 * p * p;
  }

  var prefersReducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Distance (in SVG user units) a raw pointer displacement eases toward
  // but never quite reaches - pulling harder keeps giving less, like an
  // actual rubber band, instead of a dragged node following the pointer
  // 1:1 forever.
  var RUBBER_BAND_LIMIT = 34;
  function rubberBand(dx, dy) {
    var dist = Math.hypot(dx, dy);
    if (dist < 0.001) return { x: 0, y: 0 };
    var damped = RUBBER_BAND_LIMIT * (1 - Math.exp(-dist / RUBBER_BAND_LIMIT));
    var scale = damped / dist;
    return { x: dx * scale, y: dy * scale };
  }

  var FRAME_BADGE_LABEL = {
    init: 'Init',
    visit: 'Visit',
    done: 'Done',
  };

  // -------------------------------------------------------------
  // Static DOM refs + controls that persist across scenario switches.
  // The toolbar/drawer/scenario-picker elements themselves are never
  // rebuilt - only the graph (inside #graph-container) and the stats
  // table body are. Every control below calls into `app.*`, which
  // loadScenario() reassigns on every switch - that indirection is what
  // lets these listeners be attached exactly once, ever.
  // -------------------------------------------------------------
  var graphContainer = document.getElementById('graph-container');
  var tbody = document.getElementById('stats-tbody');

  var elBadge = document.getElementById('frame-badge');
  var elCounter = document.getElementById('step-counter');
  var elDescription = document.getElementById('step-description');
  var elSlider = document.getElementById('step-slider');
  var btnBack = document.getElementById('btn-back');
  var btnNext = document.getElementById('btn-next');
  var btnReset = document.getElementById('btn-reset');
  var btnPlay = document.getElementById('btn-play');
  var scenarioSelect = document.getElementById('scenario-select');

  // The step-description and stats-table live in a sidebar docked next
  // to the canvas. It's closed by default (canvas-only UI); either
  // toggle button opens it showing that panel, and clicking the
  // already-active toggle closes it again. This is independent of which
  // scenario is loaded, so it's set up once here rather than inside
  // loadScenario().
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

  // Reassigned by every loadScenario() call below; the toolbar/keyboard
  // listeners only ever call through this object, never anything scoped
  // inside a specific loadScenario() run.
  var app = {
    next: function () {}, back: function () {}, reset: function () {},
    seek: function () {}, playToggle: function () {}, stopPlay: function () {},
  };

  btnNext.addEventListener('click', function () { app.next(); });
  btnBack.addEventListener('click', function () { app.back(); });
  btnReset.addEventListener('click', function () { app.reset(); });
  elSlider.addEventListener('input', function () { app.seek(Number(elSlider.value)); });
  btnPlay.addEventListener('click', function () { app.playToggle(); });

  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.tagName === 'INPUT') return; // let the slider handle its own arrow keys
    if (e.key === 'ArrowRight') app.next();
    else if (e.key === 'ArrowLeft') app.back();
  });

  // -------------------------------------------------------------
  // Scenario picker: populate the dropdown once from SCENARIOS (see
  // scenarios.js), then reload the whole graph/algorithm run whenever a
  // different one is picked.
  // -------------------------------------------------------------
  SCENARIOS.forEach(function (scenario, i) {
    var opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = scenario.name;
    scenarioSelect.appendChild(opt);
  });
  scenarioSelect.addEventListener('change', function () {
    loadScenario(SCENARIOS[Number(scenarioSelect.value)]);
  });

  // ===============================================================
  // loadScenario(scenario): everything below this point used to run
  // exactly once, at the top of this file, against dijkstra.js's fixed
  // NODES/EDGES/START_NODE. It's now wrapped in a function so the
  // scenario picker above can re-run it - from scratch, on a cleared
  // #graph-container and stats table - for a different graph at any
  // time. setActiveScenario() (dijkstra.js) swaps the actual NODES/
  // EDGES/START_NODE/ADJACENCY globals first, so computeFrames() and
  // every routing.js helper called below transparently operate on the
  // new scenario without needing to know scenarios exist at all.
  // ===============================================================
  function loadScenario(scenario) {
    app.stopPlay(); // halt the OUTGOING scenario's Play loop before tearing anything down

    setActiveScenario(scenario);
    var NODE_ORDER = scenario.nodeOrder;
    var START = scenario.startNode || 'S';

    // The graph's real, permanent layout - captured once per scenario,
    // before anything ever touches NODES[node].x/y, so dragging (a
    // tactile toy - see makeDraggable() below) always knows exactly
    // where "home" is to spring a node back to, even though it
    // temporarily mutates the very same NODES object the rest of the
    // app treats as fixed truth.
    var HOME = {};
    NODE_ORDER.forEach(function (node) { HOME[node] = { x: NODES[node].x, y: NODES[node].y }; });

    var nodeCenters = NODE_ORDER.map(function (node) { return NODES[node]; });

    // Every weight label placed so far, so a later edge's label can avoid
    // sitting on top of an earlier one too (see findLabelPoint below) -
    // two edges that happen to pass close to each other can otherwise get
    // their labels placed at nearly the same point independently.
    var placedLabelPoints = [];

    // Pick a point along edge a->b for its weight-label pill that avoids
    // sitting on top of any node circle OR any other edge's weight label
    // already placed. The graph layout is fixed (per scenario), so a
    // handful of candidate positions along the edge (starting at the
    // midpoint, then nudging toward either end) checked once at build
    // time is enough - no need to redo this per frame.
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
      // Fallback: nothing was collision-free (shouldn't happen on any of
      // our layouts) - just use the midpoint.
      var fallback = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      placedLabelPoints.push(fallback);
      return fallback;
    }

    // -------------------------------------------------------------
    // Build the graph from scratch: base gray edges + node circles/
    // labels + one <path> per destination for its colored route. The
    // previous scenario's SVG (if any) is discarded outright rather than
    // patched in place - different scenarios can have entirely different
    // node counts/names, so there's no stable element to reuse anyway.
    // -------------------------------------------------------------
    graphContainer.innerHTML = '';
    var svg = svgEl('svg', {
      viewBox: '0 0 660 430',
      role: 'img',
      'aria-label': 'Graph of ' + NODE_ORDER.join(', ') + ' with weighted edges',
    });
    graphContainer.appendChild(svg);

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
    // One entry per edge with everything layoutNodesAndEdges() needs to
    // re-derive its line endpoints + weight-label position live from
    // NODES, whenever a node gets dragged - see that function below.
    var edgeGeom = [];
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

      edgeGeom.push({ from: edge[0], to: edge[1], lineEl: lineEl, labelEl: labelGroup });
    });

    // One reusable <path> per destination for its colored route.
    var routeEls = {};
    NODE_ORDER.forEach(function (node) {
      if (node === START) return;
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
    // Draggable nodes - a tactile toy, not a real "move the node" feature.
    // Node positions are fixed by design (per scenario), so nothing about
    // the algorithm/graph DATA ever changes here; this only ever reads
    // NODES[node].x/y right back out of HOME once a drag ends. What DOES
    // move for real while dragging is temporarily mutating that same
    // NODES[node] entry (the one thing every other piece of geometry in
    // this file and in routing.js already reads positions from) and then
    // re-running the same layout/route-building logic those normally only
    // run once - so every connected edge and colored route line follows
    // the dragged node live, instead of only the node itself moving while
    // its lines stay behind.
    // -------------------------------------------------------------

    // Re-derives node <g> positions, base-edge line endpoints, and weight-
    // label positions purely from the current NODES x/y values. Frame-
    // independent (distances/routes aren't touched here - see
    // repositionGraph below for that), so this alone is also exactly what
    // "put the layout back to normal" means after a drag.
    function layoutNodesAndEdges() {
      NODE_ORDER.forEach(function (node) {
        var n = NODES[node];
        nodeEls[node].g.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
      });
      placedLabelPoints.length = 0; // re-run findLabelPoint's collision-avoidance from scratch
      edgeGeom.forEach(function (edge) {
        var a = NODES[edge.from], b = NODES[edge.to];
        edge.lineEl.setAttribute('x1', a.x);
        edge.lineEl.setAttribute('y1', a.y);
        edge.lineEl.setAttribute('x2', b.x);
        edge.lineEl.setAttribute('y2', b.y);
        var labelPt = findLabelPoint(a, b);
        edge.labelEl.setAttribute('transform', 'translate(' + labelPt.x + ',' + labelPt.y + ')');
      });
    }

    // Full live redraw used while a node is actively being dragged or
    // springing back: node/edge/label geometry (above) PLUS the colored
    // route paths and the current-node marker, both instantly re-derived
    // from whatever NODES currently says (no morph/grow animation - those
    // are for algorithm step changes, not a pointer drag). Deliberately
    // separate from renderStep()'s own route/marker logic, which stays in
    // charge of animating those normally; this only runs mid-drag/spring,
    // in between algorithm steps.
    function repositionGraph() {
      layoutNodesAndEdges();
      var frame = frames[currentIndex];
      var allPaths = buildAllPaths(frame);
      Object.keys(routeEls).forEach(function (node) {
        var d = allPaths[node];
        if (d) routeEls[node].setAttribute('d', d);
      });
      if (frame.processingNode) {
        var mn = NODES[frame.processingNode];
        currentMarkerGroup.style.transform = 'translate(' + mn.x + 'px, ' + mn.y + 'px)';
      }
    }

    var springAnims = {}; // node -> requestAnimationFrame id, so re-grabbing mid-spring cancels it cleanly

    function cancelSpring(node) {
      if (springAnims[node]) {
        cancelAnimationFrame(springAnims[node]);
        springAnims[node] = null;
      }
    }

    // Animates NODES[node] from wherever it currently is back to its real
    // HOME position, repositioning the whole connected graph (see
    // repositionGraph above) on every frame, so the snap-back reads as one
    // elastic motion pulling the node AND its edges/routes back together.
    function springNodeHome(node) {
      cancelSpring(node);
      var fromX = NODES[node].x, fromY = NODES[node].y;
      var toX = HOME[node].x, toY = HOME[node].y;
      if (prefersReducedMotion || (fromX === toX && fromY === toY)) {
        NODES[node].x = toX;
        NODES[node].y = toY;
        repositionGraph();
        return;
      }
      var duration = 550;
      var start = null;
      function tick(ts) {
        if (start === null) start = ts;
        var t = Math.min(1, (ts - start) / duration);
        var eased = easeOutBack(t);
        NODES[node].x = fromX + (toX - fromX) * eased;
        NODES[node].y = fromY + (toY - fromY) * eased;
        repositionGraph();
        if (t < 1) {
          springAnims[node] = requestAnimationFrame(tick);
        } else {
          NODES[node].x = toX;
          NODES[node].y = toY;
          repositionGraph();
          springAnims[node] = null;
        }
      }
      springAnims[node] = requestAnimationFrame(tick);
    }

    // Resets every node straight to HOME with no animation - used as a
    // safety net at the top of renderStep() so stepping the algorithm
    // (Next/Back/Reset/slider/Play) always starts from the real layout,
    // discarding any drag/spring-back visual state instantly rather than
    // fighting it.
    function snapAllNodesHome() {
      NODE_ORDER.forEach(function (node) {
        cancelSpring(node);
        NODES[node].x = HOME[node].x;
        NODES[node].y = HOME[node].y;
      });
      layoutNodesAndEdges();
    }

    function makeDraggable(node) {
      var g = nodeEls[node].g;
      var dragging = false;
      var startClientX = 0, startClientY = 0;
      var baseOffsetX = 0, baseOffsetY = 0; // NODES[node]'s offset from HOME when the drag started (0 unless grabbed mid-spring)

      g.addEventListener('pointerdown', function (e) {
        // Only the primary button/touch/pen contact starts a drag - and
        // ignore it entirely while the algorithm is auto-playing, so a
        // stray drag can't fight the Play loop's own rendering.
        if (e.button !== 0 || playTimer) return;
        cancelSpring(node);
        dragging = true;
        startClientX = e.clientX;
        startClientY = e.clientY;
        baseOffsetX = NODES[node].x - HOME[node].x;
        baseOffsetY = NODES[node].y - HOME[node].y;
        g.classList.add('is-dragging');
        g.setPointerCapture(e.pointerId);
      });

      g.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var ctm = svg.getScreenCTM();
        var rawDx = baseOffsetX + (e.clientX - startClientX) / ctm.a;
        var rawDy = baseOffsetY + (e.clientY - startClientY) / ctm.d;
        var offset = rubberBand(rawDx, rawDy);
        NODES[node].x = HOME[node].x + offset.x;
        NODES[node].y = HOME[node].y + offset.y;
        repositionGraph();
      });

      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        g.classList.remove('is-dragging');
        g.releasePointerCapture(e.pointerId);
        springNodeHome(node);
      }
      g.addEventListener('pointerup', endDrag);
      g.addEventListener('pointercancel', endDrag);
    }

    NODE_ORDER.forEach(makeDraggable);

    // -------------------------------------------------------------
    // Stats table rows (rebuilt fresh per scenario, text content updated
    // per render).
    // -------------------------------------------------------------
    tbody.innerHTML = '';
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
    // Algorithm frames (the actual Dijkstra run) + per-scenario state.
    // -------------------------------------------------------------
    var frames = computeFrames(START);
    var currentIndex = 0;
    var playTimer = null;

    elSlider.max = String(frames.length - 1);

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
      // Stepping the algorithm always starts from the real layout - drop
      // any drag/spring-back visual state instantly rather than letting it
      // linger or fight the render below (see snapAllNodesHome above).
      snapAllNodesHome();

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
    // Wire this scenario's controls up onto the shared `app` object -
    // every handler just computes an index and re-renders. The toolbar's
    // own listeners (attached once, above) already call app.next() etc.,
    // so simply reassigning these methods is enough to make the toolbar
    // control THIS scenario from now on.
    // -------------------------------------------------------------
    app.next = function () { stopPlay(); renderStep(currentIndex + 1); };
    app.back = function () { stopPlay(); renderStep(currentIndex - 1); };
    app.reset = function () { stopPlay(); renderStep(0); };
    app.seek = function (index) { stopPlay(); renderStep(index); };
    app.stopPlay = stopPlay;
    app.playToggle = function () {
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
    };

    renderStep(0);
  }

  setDrawerMode(null);
  loadScenario(SCENARIOS[0]);
})();
