/*
 * dijkstra.js
 * -----------
 * Pure graph data + Dijkstra's algorithm implementation.
 *
 * This file has ZERO DOM dependencies on purpose: it can be loaded in a
 * browser (as a plain <script>, it defines globals) OR required from
 * plain Node.js (see test/run-tests.js) so the algorithm's correctness can
 * be unit-tested independently of the visualization/rendering code in
 * app.js. Keeping algorithm logic separate from rendering logic is what
 * lets us claim "real Dijkstra logic, not hardcoded path snapshots" -
 * every distance/predecessor/step shown in the UI is derived here, live.
 */

// ---------------------------------------------------------------------
// Graph definition
// ---------------------------------------------------------------------

// Fixed node layout (pixel coordinates in the SVG viewBox) + the color
// assigned to each node's shortest-path "line" in the subway-map view.
// Colors come from a validated 8-slot categorical palette (blue, orange,
// aqua, yellow, magenta, green, violet, red) assigned in a fixed order to
// destinations A..H so every route keeps a stable, distinguishable color.
// S is the source/origin, not a "destination", so it gets a neutral ink
// color instead of a slot from the categorical palette.
//
// The x/y positions are computed, not hand-picked: they're the output of
// tools/generate-layout.js, a small deterministic force-directed layout
// (all-pairs repulsion + per-edge springs whose rest length scales with
// that edge's Dijkstra weight, so heavier edges end up visually longer)
// seeded from a BFS layering out of S and rotated so S reads on the
// left. Re-running that script reproduces these exact numbers - see its
// header comment for the full method.
var NODES = {
  S: { x: 55, y: 233, color: '#1d1d1b', order: 0 },
  A: { x: 212, y: 261, color: '#2a78d6', order: 1 },
  B: { x: 230, y: 127, color: '#eb6834', order: 2 },
  C: { x: 256, y: 375, color: '#1baf7a', order: 3 },
  D: { x: 427, y: 189, color: '#eda100', order: 4 },
  E: { x: 472, y: 55, color: '#e87ba4', order: 5 },
  F: { x: 401, y: 321, color: '#008300', order: 6 },
  G: { x: 548, y: 330, color: '#4a3aa7', order: 7 },
  H: { x: 605, y: 206, color: '#e34948', order: 8 },
};

// Undirected weighted edges: [nodeA, nodeB, weight]
//
// Weights read as hours on a hiking trail (a short 1hr leg between
// viewpoints, a long 6-7hr slog) rather than the much larger numbers an
// earlier "commute" framing used - chosen to keep every visit order, every
// relax outcome (discovered/improved/no-change), and every final
// shortest-path tree EXACTLY identical to that original weight set, just
// smaller. (Not a uniform rescale - the smallest original edge was already
// 1, which a uniform shrink can't go below - so these were chosen by
// solving for the same set of ">"/"<"/"=" relationships the algorithm
// actually depends on, then verified by re-running computeFrames() and
// diffing the full visit order + relaxation trace against the original.
// See test/run-tests.js, which pins the resulting distances/milestones.)
// NOTE: NODES' x/y above were laid out (tools/generate-layout.js) against
// the OLD weights, whose springs favor longer edges for heavier weights;
// re-running that tool against these would likely shuffle the layout, so
// it hasn't been - the relative heavy/light ordering is still similar
// enough that the existing layout still reads sensibly.
var EDGES = [
  ['S', 'A', 3],
  ['S', 'B', 1],
  ['S', 'C', 6],
  ['B', 'A', 1],
  ['B', 'D', 5],
  ['B', 'E', 7],
  ['A', 'C', 1],
  ['A', 'F', 3],
  ['C', 'F', 1],
  ['C', 'G', 4],
  ['F', 'H', 1],
  ['D', 'G', 1],
  ['G', 'H', 2],
  ['E', 'H', 4],
];

var START_NODE = 'S';

// ---------------------------------------------------------------------
// Adjacency list, built once from EDGES so the algorithm never has to
// special-case direction: every edge is reachable from either endpoint.
// ---------------------------------------------------------------------
function buildAdjacency() {
  var adj = {};
  Object.keys(NODES).forEach(function (n) {
    adj[n] = [];
  });
  EDGES.forEach(function (edge) {
    var a = edge[0], b = edge[1], w = edge[2];
    adj[a].push({ to: b, weight: w });
    adj[b].push({ to: a, weight: w });
  });
  // Sort each adjacency list by neighbor name so relaxation order is
  // deterministic (same result every run - needed for repeatable steps).
  Object.keys(adj).forEach(function (n) {
    adj[n].sort(function (x, y) { return x.to < y.to ? -1 : 1; });
  });
  return adj;
}

var ADJACENCY = buildAdjacency();

// Swaps in a different scenario's graph (see scenarios.js) as the active
// NODES/EDGES/START_NODE/ADJACENCY - the same globals every function in
// this file and in routing.js already reads from, so nothing about the
// algorithm or the rendering logic needs to know scenarios exist. Used
// by app.js's loadScenario() whenever the scenario dropdown changes.
function setActiveScenario(scenario) {
  NODES = scenario.nodes;
  EDGES = scenario.edges;
  START_NODE = scenario.startNode || 'S';
  ADJACENCY = buildAdjacency();
}

function edgeKey(a, b) {
  return [a, b].sort().join('-');
}

function edgeWeight(a, b) {
  var found = ADJACENCY[a].find(function (e) { return e.to === b; });
  return found ? found.weight : null;
}

// Walk a predecessor map backwards from `node` to START_NODE and return
// the ordered list of node keys forming the best-known path, e.g.
// ['S', 'B', 'A', 'C']. Returns null if the node is unreached (Infinity).
function pathTo(node, dist, prev) {
  if (dist[node] === Infinity) return null;
  var path = [node];
  var cur = node;
  while (cur !== START_NODE) {
    var p = prev[cur];
    if (p == null) return null; // safety guard, should not happen
    path.push(p);
    cur = p;
  }
  path.reverse();
  return path;
}

function formatPath(path) {
  return path ? path.join(' → ') : '—'; // em dash for "not reached"
}

// ---------------------------------------------------------------------
// computeFrames(startNode)
// -------------------------------------------------------------------
// Runs the textbook Dijkstra algorithm and records one "frame" per node
// visit (plus a bookend 'init' and 'done' frame):
//   - 'init'  : initial distances set (S=0, everything else = Infinity)
//   - 'visit' : the unvisited node with the smallest tentative distance is
//               selected, marked visited, AND every one of its outgoing
//               edges is relaxed - all in this single step. The frame's
//               `relaxations` array records, for every neighbor examined,
//               whether it was a first discovery, a shortcut improvement,
//               or no change, so the UI can describe the whole visit at
//               once instead of one micro-step per edge.
//   - 'done'  : every reachable node has been visited
//
// Each frame is a fully independent deep copy of { dist, prev, visited }
// at that exact moment, plus bookkeeping the UI needs (currentNode,
// relaxations, a human-readable description). Storing a snapshot per visit
// - rather than re-deriving state on every UI step - is what makes
// Back/Next/the slider trivial: navigating steps is just indexing into
// this array, and every value shown was produced by actually running the
// algorithm (nothing here is a hand-typed answer for the demo cases).
// ---------------------------------------------------------------------
function computeFrames(startNode) {
  startNode = startNode || START_NODE;
  var dist = {};
  var prev = {};
  var visited = {};

  Object.keys(NODES).forEach(function (n) {
    dist[n] = n === startNode ? 0 : Infinity;
    prev[n] = null;
  });

  var frames = [];

  function pushFrame(extra) {
    frames.push(Object.assign({
      dist: Object.assign({}, dist),
      prev: Object.assign({}, prev),
      visited: Object.assign({}, visited),
    }, extra));
  }

  pushFrame({
    type: 'init',
    currentNode: null,
    processingNode: null,
    relaxations: [],
    description: 'Initialize: distance(' + startNode + ') = 0. Every other ' +
      'node starts at distance = ∞ (unknown) with no predecessor.',
  });

  var totalNodes = Object.keys(NODES).length;
  var visitedCount = 0;

  while (visitedCount < totalNodes) {
    // --- Step: "process the unvisited node with the smallest tentative
    // distance" -----------------------------------------------------
    var u = null;
    var best = Infinity;
    Object.keys(NODES).forEach(function (n) {
      if (!visited[n] && dist[n] < best) {
        best = dist[n];
        u = n;
      }
    });

    if (u === null) break; // remaining nodes are unreachable

    visited[u] = true;
    visitedCount++;

    // --- One whole step = visit u AND relax every one of its outgoing
    // edges in a single frame (rather than a separate frame per edge).
    // Each relaxation result is recorded so the description can spell out
    // exactly what happened to every neighbor this step touched.
    var relaxations = [];
    ADJACENCY[u].forEach(function (edge) {
      var v = edge.to;
      var w = edge.weight;
      if (visited[v]) return; // never re-relax a finalized node

      var oldDist = dist[v];
      var alt = dist[u] + w;
      var reason;

      if (alt < oldDist) {
        dist[v] = alt;
        prev[v] = u;
        reason = oldDist === Infinity ? 'discovered' : 'improved';
      } else {
        reason = 'no-change';
      }

      relaxations.push({ from: u, to: v, weight: w, oldDist: oldDist, newDist: dist[v], reason: reason });
    });

    // Build one combined, human-readable description for the whole step:
    // node selection first, then one sentence per relaxed edge.
    var sentences = [];
    sentences.push(u === startNode
      ? 'Start at ' + u + ' with distance 0.'
      : 'Visit ' + u + ' — the unvisited node with the smallest tentative ' +
        'distance (d(' + u + ') = ' + dist[u] + '). Mark it visited.');

    relaxations.forEach(function (r) {
      var path = pathTo(r.to, dist, prev);
      if (r.reason === 'discovered') {
        sentences.push('Relax ' + r.from + '→' + r.to + ' (weight ' + r.weight +
          '): ' + r.to + ' was unreached (∞); ' + r.from + '\'s distance ' + dist[u] +
          ' + ' + r.weight + ' = ' + r.newDist + ' is better. Set distance(' + r.to +
          ') = ' + r.newDist + ', predecessor = ' + r.from + '. Path: ' + formatPath(path) + '.');
      } else if (r.reason === 'improved') {
        sentences.push('Relax ' + r.from + '→' + r.to + ' (weight ' + r.weight +
          '): candidate distance ' + dist[u] + ' + ' + r.weight + ' = ' + r.newDist +
          ' is less than the current distance(' + r.to + ') = ' + r.oldDist +
          '. Shortcut found! Update distance(' + r.to + ') = ' + r.newDist +
          ', predecessor = ' + r.from + '. New path: ' + formatPath(path) + '.');
      } else {
        sentences.push('Relax ' + r.from + '→' + r.to + ' (weight ' + r.weight +
          '): candidate distance ' + dist[u] + ' + ' + r.weight + ' = ' + r.newDist +
          ' is not better than the current distance(' + r.to + ') = ' + r.oldDist + '. No update.');
      }
    });

    pushFrame({
      type: 'visit',
      currentNode: u,
      processingNode: u,
      relaxations: relaxations,
      description: sentences.join(' '),
    });
  }

  pushFrame({
    type: 'done',
    currentNode: null,
    processingNode: null,
    relaxations: [],
    description: 'All reachable nodes visited. Every distance and route ' +
      'below is now final and mathematically shortest from ' + startNode + '.',
  });

  return frames;
}

// Export for Node (unit tests) while staying a plain global script in the
// browser (no bundler / module system required for the demo itself).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NODES: NODES,
    EDGES: EDGES,
    START_NODE: START_NODE,
    ADJACENCY: ADJACENCY,
    edgeKey: edgeKey,
    edgeWeight: edgeWeight,
    pathTo: pathTo,
    formatPath: formatPath,
    computeFrames: computeFrames,
    setActiveScenario: setActiveScenario,
  };
}
