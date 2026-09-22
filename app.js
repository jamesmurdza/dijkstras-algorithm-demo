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
 *     table, slider, buttons) are kept in sync from - Back / Next / the
 *     slider all just compute the next index and call it, so there is no
 *     way for the controls to drift out of sync with each other.
 *   - the toolbar's buttons/slider/keyboard shortcuts are wired up ONCE,
 *     at the bottom of this file, calling into a small `app` object
 *     whose methods (next/back/seek) get reassigned by every
 *     loadScenario() call - that indirection is what lets the toolbar
 *     keep working across scenario switches without ever attaching a
 *     second, duplicate set of listeners to the same buttons.
 *
 * All algorithm state (distances, predecessors, visited set) comes from
 * dijkstra.js's computeFrames(); all path geometry comes from
 * routing.js's buildAllPaths(). This file never invents a distance or a
 * route on its own - it only displays what those two files computed for
 * whichever scenario (see scenarios.js) is currently active.
 */

(function () {
  'use strict';

  // Node circle radius: big enough to fit a single bold letter when the
  // "show vertex labels" setting is on, or a smaller plain dot when it's
  // off (see settings below) - NODE_R itself becomes a per-loadScenario()
  // local (it depends on that setting), computed from whichever of these
  // two is active.
  var NODE_R_WITH_LABEL = 12;
  var NODE_R_NO_LABEL = 7;

  // Half-width of the flat top edge of the small "currently visiting"
  // marker (see currentMarkerGroup below) - the rest of its geometry is
  // NODE_R-relative, so it's computed alongside NODE_R inside
  // loadScenario() too, since it needs to stay proportioned to whichever
  // circle size is currently active.
  var CHEVRON_HALF_W = 6.5;

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
  var RUBBER_BAND_LIMIT = 70;
  function rubberBand(dx, dy) {
    var dist = Math.hypot(dx, dy);
    if (dist < 0.001) return { x: 0, y: 0 };
    var damped = RUBBER_BAND_LIMIT * (1 - Math.exp(-dist / RUBBER_BAND_LIMIT));
    var scale = damped / dist;
    return { x: dx * scale, y: dy * scale };
  }

  // -------------------------------------------------------------
  // Static DOM refs + controls that persist across scenario switches.
  // The toolbar/sidebar/scenario-picker elements themselves are never
  // rebuilt - only the graph (inside #graph-container) and the stats
  // table body are. Every control below calls into `app.*`, which
  // loadScenario() reassigns on every switch - that indirection is what
  // lets these listeners be attached exactly once, ever.
  // -------------------------------------------------------------
  var graphContainer = document.getElementById('graph-container');
  var tbody = document.getElementById('stats-tbody');

  var elSlider = document.getElementById('step-slider');
  var sliderTicks = document.getElementById('slider-ticks');
  var btnBack = document.getElementById('btn-back');
  var btnNext = document.getElementById('btn-next');
  var scenarioSelect = document.getElementById('scenario-select');

  // The sidebar (table / settings / pseudocode / how-it-works) is docked
  // to the LEFT of the canvas. It's collapsed to just its own header bar
  // (title + toggle) by default - collapsing/expanding toggles a CSS
  // class rather than the `hidden` attribute, since the toggle button
  // now lives INSIDE the sidebar's header (next to the title) and that
  // header needs to stay visible/reachable even while collapsed, or
  // there'd be no way to expand it again. Its own tab strip (independent
  // of that toggle) switches which one of the four panels is showing
  // while it's expanded. Both are independent of which scenario is
  // loaded, so this is set up once here rather than inside
  // loadScenario().
  var sidebar = document.getElementById('sidebar');
  var btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  var sidebarTabButtons = Array.prototype.slice.call(document.querySelectorAll('.sidebar-tab'));
  var sidebarPanels = Array.prototype.slice.call(document.querySelectorAll('.sidebar-panel'));
  var sidebarOpen = false;
  var activeSidebarTab = 'table';
  var sidebarWidth = null; // px, only set once the user drags the resize handle - null means "use the CSS default"

  function updateSidebarUI() {
    sidebar.classList.toggle('is-collapsed', !sidebarOpen);
    // The collapsed rail's 44px width is CSS-driven (.sidebar.is-collapsed);
    // a leftover inline flex-basis from a resize would otherwise outrank
    // it (inline styles always beat stylesheet rules), so this is cleared
    // whenever collapsed and only reapplied once expanded again.
    sidebar.style.flexBasis = (sidebarOpen && sidebarWidth) ? sidebarWidth + 'px' : '';
    btnToggleSidebar.setAttribute('aria-pressed', String(sidebarOpen));
    var toggleLabel = sidebarOpen ? 'Collapse the sidebar' : 'Expand the sidebar';
    btnToggleSidebar.title = toggleLabel;
    btnToggleSidebar.setAttribute('aria-label', toggleLabel);
    sidebarTabButtons.forEach(function (btn) {
      var tab = btn.id.replace('tab-btn-', '');
      btn.setAttribute('aria-selected', String(tab === activeSidebarTab));
    });
    sidebarPanels.forEach(function (panel) {
      panel.classList.toggle('is-active', panel.id === 'tab-' + activeSidebarTab);
    });
  }

  btnToggleSidebar.addEventListener('click', function () {
    sidebarOpen = !sidebarOpen;
    updateSidebarUI();
  });
  sidebarTabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      activeSidebarTab = btn.id.replace('tab-btn-', '');
      updateSidebarUI();
    });
  });
  updateSidebarUI();

  // -------------------------------------------------------------
  // Drag-to-resize the sidebar's width, via the thin invisible hit
  // target layered over its existing right border (see .sidebar-resize-
  // handle in styles.css - no visible change to the border itself, only
  // the cursor and this drag behavior are new). Only meaningful while
  // expanded - the handle itself is hidden by CSS while collapsed.
  // -------------------------------------------------------------
  var sidebarResizeHandle = document.getElementById('sidebar-resize-handle');
  var MIN_SIDEBAR_WIDTH = 240;
  var MAX_SIDEBAR_WIDTH = 560;

  sidebarResizeHandle.addEventListener('pointerdown', function (e) {
    if (!sidebarOpen || e.button !== 0) return;
    e.preventDefault();
    var startX = e.clientX;
    var startWidth = sidebar.getBoundingClientRect().width;
    sidebarResizeHandle.setPointerCapture(e.pointerId);
    // A live drag should track the cursor exactly, not ease toward it
    // frame by frame - see .sidebar.is-resizing in styles.css.
    sidebar.classList.add('is-resizing');

    function onMove(ev) {
      var next = startWidth + (ev.clientX - startX);
      next = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, next));
      sidebarWidth = next;
      sidebar.style.flexBasis = next + 'px';
    }
    function onUp(ev) {
      sidebar.classList.remove('is-resizing');
      sidebarResizeHandle.releasePointerCapture(ev.pointerId);
      sidebarResizeHandle.removeEventListener('pointermove', onMove);
      sidebarResizeHandle.removeEventListener('pointerup', onUp);
    }
    sidebarResizeHandle.addEventListener('pointermove', onMove);
    sidebarResizeHandle.addEventListener('pointerup', onUp);
  });

  // -------------------------------------------------------------
  // Display settings: both on by default. Global (not per-scenario) -
  // toggling one rebuilds the CURRENTLY active scenario's graph in place
  // (see the checkbox listeners below), preserving whatever step the
  // algorithm run is currently on rather than resetting to the start.
  // -------------------------------------------------------------
  var settings = {
    showVertexLabels: true,
    showEdgeWeights: true,
  };
  var currentScenario = SCENARIOS[0]; // updated by the scenario picker below; read back by the settings checkboxes
  var elSettingVertexLabels = document.getElementById('setting-vertex-labels');
  var elSettingEdgeWeights = document.getElementById('setting-edge-weights');
  elSettingVertexLabels.checked = settings.showVertexLabels;
  elSettingEdgeWeights.checked = settings.showEdgeWeights;

  elSettingVertexLabels.addEventListener('change', function () {
    settings.showVertexLabels = elSettingVertexLabels.checked;
    loadScenario(currentScenario, app.getCurrentIndex());
  });
  elSettingEdgeWeights.addEventListener('change', function () {
    settings.showEdgeWeights = elSettingEdgeWeights.checked;
    loadScenario(currentScenario, app.getCurrentIndex());
  });

  // Reassigned by every loadScenario() call below; the toolbar/keyboard
  // listeners only ever call through this object, never anything scoped
  // inside a specific loadScenario() run.
  var app = {
    next: function () {}, back: function () {}, seek: function () {},
  };

  // Last known real pointer position, tracked once here (scenario-
  // independent) so resyncHoverHighlight() (inside loadScenario, below)
  // can do a fresh, explicit-coordinate elementFromPoint() hit-test
  // instead of trusting the browser's own `:hover` bookkeeping - which
  // (at least in Chromium, observed empirically) can go briefly stale
  // immediately after a render forces a synchronous layout read, even
  // though the pointer never actually moved.
  var lastMouseX = -1, lastMouseY = -1;
  document.addEventListener('mousemove', function (e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  btnNext.addEventListener('click', function () { app.next(); });
  btnBack.addEventListener('click', function () { app.back(); });
  elSlider.addEventListener('input', function () { app.seek(Number(elSlider.value)); });

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
    currentScenario = SCENARIOS[Number(scenarioSelect.value)];
    loadScenario(currentScenario); // no startIndex - a genuine scenario change always starts over at step 0
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
  function loadScenario(scenario, startIndex) {
    setActiveScenario(scenario);
    var NODE_ORDER = scenario.nodeOrder;
    var START = scenario.startNode || 'S';

    // This build's node radius + "currently visiting" marker geometry -
    // both depend on settings.showVertexLabels (see NODE_R_WITH_LABEL/
    // NODE_R_NO_LABEL up top), so they're computed fresh on every build
    // rather than once as fixed top-level constants.
    var NODE_R = settings.showVertexLabels ? NODE_R_WITH_LABEL : NODE_R_NO_LABEL;
    var CHEVRON_TOP_Y = -(NODE_R + 18);
    var CHEVRON_TIP_Y = -(NODE_R + 8);

    // Weight-to-stroke-width scale for this build, used only when
    // settings.showEdgeWeights is off (see weightToWidth below) - a
    // straight linear map from THIS scenario's own actual min/max edge
    // weight to a fixed pixel range, so "thickest line on screen" always
    // means "this scenario's heaviest edge" regardless of what the raw
    // weight numbers happen to be.
    var MIN_STROKE = 1.5, MAX_STROKE = 9;
    var edgeWeightValues = EDGES.map(function (e) { return e[2]; });
    var minEdgeWeight = Math.min.apply(null, edgeWeightValues);
    var maxEdgeWeight = Math.max.apply(null, edgeWeightValues);
    function weightToWidth(w) {
      if (maxEdgeWeight === minEdgeWeight) return (MIN_STROKE + MAX_STROKE) / 2;
      var t = (w - minEdgeWeight) / (maxEdgeWeight - minEdgeWeight);
      return Math.round((MIN_STROKE + t * (MAX_STROKE - MIN_STROKE)) * 10) / 10;
    }

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
      // Inline style, not the attribute - it needs to win over the
      // .edge-base rule regardless of specificity (see styles.css).
      lineEl.style.strokeWidth = (settings.showEdgeWeights ? 3 : weightToWidth(w)) + 'px';
      gEdgesBase.appendChild(lineEl);
      edgeEls[edgeKey(edge[0], edge[1])] = lineEl;

      // Weight label near the midpoint (nudged off-center only when the
      // midpoint would otherwise collide with a node circle or an already-
      // placed label - see findLabelPoint), with a small round bubble
      // behind it for legibility over crossing/bundled lines. Radius is
      // sized to comfortably fit the widest weight in this graph (two
      // digits, e.g. "20") without the text touching the edge of the circle.
      // Only built at all when settings.showEdgeWeights is on - when it's
      // off, the edge's own thickness (set above) carries the weight
      // instead, so there's nothing to label.
      var labelGroup = null;
      if (settings.showEdgeWeights) {
        var labelPt = findLabelPoint(a, b);
        labelGroup = svgEl('g', { class: 'edge-weight', transform: 'translate(' + labelPt.x + ',' + labelPt.y + ')' });
        labelGroup.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 9.5 }));
        var text = svgEl('text', { x: 0, y: 3, 'text-anchor': 'middle' });
        text.textContent = w;
        labelGroup.appendChild(text);
        gEdgeLabels.appendChild(labelGroup);
      }

      edgeGeom.push({ from: edge[0], to: edge[1], lineEl: lineEl, labelEl: labelGroup });
    });

    // One "route group" <g> per destination for its colored route. When
    // settings.showEdgeWeights is on, it holds exactly one <path> - the
    // whole route as a single smooth shape (routing.js's
    // buildDestinationPathD) - so the morph/grow animations further
    // below (which need one element to resample/measure) keep working
    // exactly as before. When it's off, it instead holds one <path> PER
    // HOP (routing.js's buildDestinationHopSegments), each independently
    // stroke-width'd to its own edge's weight, since a single <path>
    // can't vary its own stroke-width along its length - see
    // syncRouteSegmentEls below, which keeps that per-hop element count
    // in sync every render (hop count changes whenever the shortest path
    // itself does). Segments mode deliberately skips the morph/draw-on
    // animations - a plain opacity fade (the existing .route-path CSS
    // transition) carries a first appearance instead, and shape changes
    // just snap - animating a set of independently-widthed segments
    // smoothly would need much more machinery for a secondary display
    // mode.
    var showWeights = settings.showEdgeWeights;
    var routeEls = {};
    NODE_ORDER.forEach(function (node) {
      if (node === START) return;
      var g = svgEl('g', { class: 'route-group', 'data-node': node });
      gPaths.appendChild(g);
      var rec = { g: g, mode: showWeights ? 'single' : 'segments', els: [], color: NODES[node].color };
      if (rec.mode === 'single') {
        var el = svgEl('path', { class: 'route-path', id: 'route-' + node, fill: 'none', stroke: rec.color });
        el.style.strokeWidth = '4px';
        g.appendChild(el);
        rec.els.push(el);
        rec.singleEl = el;
      }
      routeEls[node] = rec;
    });

    // Adds/removes <path> children of a segments-mode route group so it
    // has exactly one per hop, then sets each one's shape + weight-scaled
    // width. Reusing existing elements where possible (rather than
    // always clearing and rebuilding) keeps their is-visible/is-
    // highlighted classes and CSS transitions intact across renders.
    function syncRouteSegmentEls(rec, hops) {
      while (rec.els.length < hops.length) {
        var el = svgEl('path', { class: 'route-path', fill: 'none', stroke: rec.color });
        rec.g.appendChild(el);
        rec.els.push(el);
      }
      while (rec.els.length > hops.length) {
        rec.els.pop().remove();
      }
      hops.forEach(function (hop, i) {
        rec.els[i].setAttribute('d', hop.d);
        rec.els[i].style.strokeWidth = weightToWidth(hop.weight) + 'px';
      });
    }

    // Node circles + labels. (Distance values live only in the edge weight
    // labels and the stats table now - no per-node distance badge.) The
    // label is left with no text content at all when
    // settings.showVertexLabels is off, rather than hidden via CSS -
    // there's nothing there to hide.
    var nodeEls = {};
    NODE_ORDER.forEach(function (node) {
      var n = NODES[node];
      var g = svgEl('g', { class: 'node', 'data-node': node, transform: 'translate(' + n.x + ',' + n.y + ')' });

      var circle = svgEl('circle', { class: 'node-circle', r: NODE_R, fill: n.color });
      var label = svgEl('text', { class: 'node-label', y: 4, 'text-anchor': 'middle', fill: textColorFor(n.color) });
      if (settings.showVertexLabels) label.textContent = node;

      g.appendChild(circle);
      g.appendChild(label);
      gNodes.appendChild(g);

      nodeEls[node] = { g: g };
    });

    // -------------------------------------------------------------
    // Hover highlight: mousing over a node OR its own colored route
    // lightens BOTH together (its circle and the full path, one <path>
    // element, from S to it), so it's easy to pick a single destination's
    // line out of a busy parallel-lane bundle. S itself has no route of
    // its own, so hovering it only lightens the node.
    //
    // mouseenter/mouseleave drive this for instant response, but they're
    // NOT trusted as the sole source of truth: a render that forces a
    // synchronous layout read (getBoundingClientRect()/getTotalLength()
    // in the path-animation helpers above, whenever a route grows/morphs
    // this step) can make Chromium re-run its own hit-test under a
    // perfectly stationary pointer and fire a stray mouseleave with no
    // matching mouseenter after - which would otherwise leave a route
    // stuck un-highlighted even while still being hovered, e.g. on every
    // Play tick. resyncHoverHighlight() (called at the end of every
    // renderStep) is the correction: it re-derives is-highlighted from
    // the browser's own live `:hover` match, which can't desync since
    // it's not state we're tracking ourselves - it's the actual current
    // pointer position, recomputed on demand.
    // -------------------------------------------------------------
    function setHighlighted(node, on) {
      nodeEls[node].g.classList.toggle('is-highlighted', on);
      var rec = routeEls[node];
      if (rec) rec.els.forEach(function (el) { el.classList.toggle('is-highlighted', on); });
      // Guarded rather than an unconditional show/hide: resyncHoverHighlight()
      // below calls setHighlighted(node, false) for every OTHER node on every
      // render, and this bubble is a single shared element (see above) - so
      // only hide it when the node losing its highlight is the one it's
      // currently attributed to, or a later node's "show" in the same pass
      // would get immediately clobbered by an earlier node's "hide".
      if (on) {
        showDistanceBubble(node);
      } else if (bubbleNode === node) {
        hideDistanceBubble();
      }
    }

    function resyncHoverHighlight() {
      var hoveredNode = null;
      if (lastMouseX >= 0) {
        var el = document.elementFromPoint(lastMouseX, lastMouseY);
        var nodeG = el && el.closest && el.closest('.node');
        var routeG = el && el.closest && el.closest('.route-group');
        if (nodeG) {
          hoveredNode = nodeG.getAttribute('data-node');
        } else if (routeG) {
          hoveredNode = routeG.getAttribute('data-node');
        }
      }
      NODE_ORDER.forEach(function (node) { setHighlighted(node, node === hoveredNode); });
    }

    NODE_ORDER.forEach(function (node) {
      var g = nodeEls[node].g;
      var rec = routeEls[node]; // undefined for START - there's no route "to" the origin

      g.addEventListener('mouseenter', function () { setHighlighted(node, true); });
      g.addEventListener('mouseleave', function () { setHighlighted(node, false); });
      if (rec) {
        // mouseenter/leave on the GROUP fire correctly for entering/
        // leaving any of its child paths - a <g>'s hit area (and hence
        // its "already contains the pointer" state) is the union of its
        // children's painted geometry, exactly like an HTML element with
        // descendants, so this works the same whether the group holds
        // one path (weights shown) or several (segments mode).
        rec.g.addEventListener('mouseenter', function () { setHighlighted(node, true); });
        rec.g.addEventListener('mouseleave', function () { setHighlighted(node, false); });
      }
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

    // Hover distance readout - a small pill showing a node's current
    // tentative distance ("∞" until discovered, else a number), shown
    // whenever that node OR its route is hovered (setHighlighted below is
    // the single place both paths funnel through). Always anchored to the
    // NODE's own position rather than the cursor, so hovering any point
    // along a long route still reads out next to the vertex it belongs
    // to. Same "one shared element, repositioned/relabeled" pattern as
    // currentMarkerGroup above rather than one per node. Offset up-and-
    // right (not straight up) so it doesn't collide with the "you are
    // here" triangle, which already owns the space directly above a node.
    var distanceBubbleGroup = svgEl('g', { class: 'distance-bubble' });
    var distanceBubbleRect = svgEl('rect', { class: 'distance-bubble-rect' });
    var distanceBubbleText = svgEl('text', { class: 'distance-bubble-text', 'text-anchor': 'middle', y: 4 });
    distanceBubbleGroup.appendChild(distanceBubbleRect);
    distanceBubbleGroup.appendChild(distanceBubbleText);
    gNodes.appendChild(distanceBubbleGroup);

    var bubbleNode = null; // which node's distance the shared bubble is currently attributed to, if any

    function positionDistanceBubble() {
      var n = NODES[bubbleNode];
      var offsetX = NODE_R + 14;
      var offsetY = -(NODE_R + 12);
      distanceBubbleGroup.style.transform = 'translate(' + (n.x + offsetX) + 'px, ' + (n.y + offsetY) + 'px)';
    }

    function showDistanceBubble(node) {
      bubbleNode = node;
      var frame = frames[currentIndex];
      var d = frame.dist[node];
      var label = d === Infinity ? '∞' : String(d);
      distanceBubbleText.textContent = label;

      // Size the pill to fit whatever text it's showing (a lone digit vs.
      // "∞" vs. a multi-digit sum from a larger custom scenario) instead
      // of a fixed width that would either clip or look oversized.
      var box = distanceBubbleText.getBBox();
      var padX = 8, padY = 4;
      var w = Math.max(box.width + padX * 2, 22);
      var h = box.height + padY * 2;
      distanceBubbleRect.setAttribute('x', -w / 2);
      distanceBubbleRect.setAttribute('y', -h / 2);
      distanceBubbleRect.setAttribute('width', w);
      distanceBubbleRect.setAttribute('height', h);
      distanceBubbleRect.setAttribute('rx', h / 2);
      distanceBubbleRect.setAttribute('ry', h / 2);

      positionDistanceBubble();
      distanceBubbleGroup.classList.add('is-visible');
    }

    function hideDistanceBubble() {
      bubbleNode = null;
      distanceBubbleGroup.classList.remove('is-visible');
    }

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
        if (edge.labelEl) { // null when settings.showEdgeWeights is off - nothing to reposition
          var labelPt = findLabelPoint(a, b);
          edge.labelEl.setAttribute('transform', 'translate(' + labelPt.x + ',' + labelPt.y + ')');
        }
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
      if (showWeights) {
        var allPaths = buildAllPaths(frame);
        Object.keys(routeEls).forEach(function (node) {
          var d = allPaths[node];
          if (d) routeEls[node].singleEl.setAttribute('d', d);
        });
      } else {
        var allSegments = buildAllHopSegments(frame);
        Object.keys(routeEls).forEach(function (node) {
          var hops = allSegments[node];
          if (hops) syncRouteSegmentEls(routeEls[node], hops);
        });
      }
      if (frame.processingNode) {
        var mn = NODES[frame.processingNode];
        currentMarkerGroup.style.transform = 'translate(' + mn.x + 'px, ' + mn.y + 'px)';
      }
      if (bubbleNode) positionDistanceBubble();
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
        // Only the primary button/touch/pen contact starts a drag.
        if (e.button !== 0) return;
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

      // Same "colored circle with the letter inside" chip as the graph's
      // own nodes (see textColorFor above), not a separate dot-plus-text
      // convention - one visual language for "this is node X" everywhere.
      var tdNode = document.createElement('td');
      var chip = document.createElement('span');
      chip.className = 'node-chip';
      chip.textContent = node;
      chip.style.background = NODES[node].color;
      chip.style.color = textColorFor(NODES[node].color);
      tdNode.appendChild(chip);

      // Status is an icon, not a word - the full word still exists as
      // the cell's title/aria-label (below, in renderStep) so it's not
      // lost for screen readers or on hover.
      var tdStatus = document.createElement('td');
      tdStatus.className = 'status-cell';
      var statusIcon = document.createElement('span');
      statusIcon.className = 'status-icon';
      tdStatus.appendChild(statusIcon);

      var tdDist = document.createElement('td');
      tdDist.className = 'num';

      tr.appendChild(tdNode);
      tr.appendChild(tdStatus);
      tr.appendChild(tdDist);
      tbody.appendChild(tr);

      tableCells[node] = { row: tr, status: tdStatus, statusIcon: statusIcon, dist: tdDist };
    });

    // -------------------------------------------------------------
    // Algorithm frames (the actual Dijkstra run) + per-scenario state.
    // -------------------------------------------------------------
    var frames = computeFrames(START);
    var currentIndex = 0;

    elSlider.max = String(frames.length - 1);

    // Tick marks: one small crossline per discrete step the slider can
    // land on, so every notch is visible rather than just implied by the
    // step attribute. Frame count varies per scenario, so these are
    // rebuilt fresh on every load rather than being static markup.
    sliderTicks.innerHTML = '';
    frames.forEach(function (frame, i) {
      var tick = document.createElement('span');
      tick.className = 'slider-tick';
      tick.style.left = (frames.length === 1 ? 0 : (i / (frames.length - 1)) * 100) + '%';
      sliderTicks.appendChild(tick);
    });

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

      // --- slider -----------------------------------------------------
      elSlider.value = String(currentIndex);

      btnBack.disabled = currentIndex === 0;
      btnNext.disabled = currentIndex === frames.length - 1;

      // --- colored subway paths, derived fresh from this frame -------
      // (collectEdgeUsage is the same routing.js helper buildAllPaths uses
      // internally - reusing it here keeps "which edges are solid" and
      // "which edges the colored lines run through" from ever disagreeing.)
      var edgeUsage = collectEdgeUsage(frame);
      if (showWeights) {
        var allPaths = buildAllPaths(frame);
        Object.keys(routeEls).forEach(function (node) {
          var d = allPaths[node];
          var el = routeEls[node].singleEl;
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
      } else {
        // Segments mode: no morph/draw-on animation (see the routeEls
        // build comment above) - each hop's own <path> just gets its
        // shape/width set directly, with a plain CSS opacity fade for
        // first appearance.
        var allSegments = buildAllHopSegments(frame);
        Object.keys(routeEls).forEach(function (node) {
          var hops = allSegments[node];
          var rec = routeEls[node];
          if (hops) {
            syncRouteSegmentEls(rec, hops);
            rec.els.forEach(function (el) { el.classList.add('is-visible'); });
          } else {
            rec.els.forEach(function (el) { el.classList.remove('is-visible'); });
          }
        });
      }

      // --- base edges: solid once part of the current shortest-path tree,
      // dashed while still untraversed -----------------------------------
      Object.keys(edgeEls).forEach(function (key) {
        edgeEls[key].classList.toggle('is-used', !!edgeUsage[key]);
      });

      // --- node visual states -----------------------------------------
      // classList.toggle (not setAttribute('class', ...)) so this only
      // ever touches the two classes it actually manages - overwriting
      // the whole class attribute here would also wipe out is-dragging
      // and, worse, is-highlighted (hover - see the mouseenter/leave
      // wiring above) every single render, which during Play means the
      // hover glow would flicker off on every 2.2s tick even while the
      // mouse never left the node.
      NODE_ORDER.forEach(function (node) {
        var isCurrent = frame.processingNode === node;
        var isVisited = !!frame.visited[node];
        var g = nodeEls[node].g;
        g.classList.toggle('is-current', isCurrent);
        g.classList.toggle('is-visited', isVisited);
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
        var statusWord = isCurrent ? 'Processing now' : (isVisited ? 'Visited' : 'Unvisited');
        var statusGlyph = isCurrent ? '●' : (isVisited ? '✓' : '○');
        cells.statusIcon.textContent = statusGlyph;
        cells.statusIcon.className = 'status-icon' +
          (isCurrent ? ' status-icon--current' : isVisited ? ' status-icon--visited' : ' status-icon--unvisited');
        // The word itself isn't shown - only the icon is - but it's still
        // here for a tooltip and for screen readers via aria-label.
        cells.status.title = statusWord;
        cells.status.setAttribute('aria-label', statusWord);
        cells.dist.textContent = frame.dist[node] === Infinity ? '∞' : String(frame.dist[node]);
        cells.row.className = 'stats-row' + (isCurrent ? ' is-current' : '') + (isVisited ? ' is-visited' : '');
      });

      // Correct any hover-highlight desync this render's DOM churn may
      // have caused (see resyncHoverHighlight's own comment above) -
      // always last, once every other change this render makes is done.
      resyncHoverHighlight();
    }

    // -------------------------------------------------------------
    // Wire this scenario's controls up onto the shared `app` object -
    // every handler just computes an index and re-renders. The toolbar's
    // own listeners (attached once, above) already call app.next() etc.,
    // so simply reassigning these methods is enough to make the toolbar
    // control THIS scenario from now on.
    // -------------------------------------------------------------
    app.next = function () { renderStep(currentIndex + 1); };
    app.back = function () { renderStep(currentIndex - 1); };
    app.seek = function (index) { renderStep(index); };
    app.getCurrentIndex = function () { return currentIndex; }; // read by the settings checkboxes, so toggling one can rebuild in place without losing the current step

    renderStep(typeof startIndex === 'number' ? startIndex : 0);
  }

  loadScenario(SCENARIOS[0]);
})();
