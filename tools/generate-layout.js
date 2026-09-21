/*
 * tools/generate-layout.js
 * -------------------------
 * One-time force-directed layout generator for the Dijkstra demo graph.
 * NOT part of the shipped app - app.js/dijkstra.js only ever read the
 * fixed x/y coordinates baked into dijkstra.js's NODES object (the app
 * requires static positions at runtime). This script is just a
 * principled way to DERIVE a good set of those fixed coordinates -
 * computed rather than eyeballed - the way you'd use any graph-layout
 * tool once, at design time, then hand-copy the result into place.
 *
 * Run with:  node tools/generate-layout.js
 * It prints the computed { NODE: {x, y} } coordinates as JSON, plus a
 * couple of sanity diagnostics (closest node pair, per-edge lengths).
 *
 * METHOD:
 *  1. Seed initial positions with a BFS-layer layout from S (hop-distance
 *     controls initial x, spreads nodes within a layer along y) - this
 *     gives the simulation a well-conditioned starting point so it
 *     converges to something orderly instead of a random tangle.
 *  2. Run a custom force simulation:
 *       - all-pairs repulsion (inverse-square, like electrostatic charge)
 *         so nodes never crowd or overlap
 *       - per-edge Hookean springs whose REST LENGTH scales with the
 *         edge's Dijkstra weight (sqrt-compressed so a weight-20 edge
 *         doesn't blow up the canvas 20x vs a weight-1 edge) - heavier
 *         edges end up visually longer, echoing a real map where
 *         distance corresponds to cost
 *       - a gentle centering pull so the whole layout doesn't drift
 *     with a cooling schedule (bigger steps early, smaller/settling
 *     steps later) for stable convergence.
 *  3. Post-process: rotate the converged layout so S sits on the left
 *     and the graph reads roughly left-to-right (matching the demo's
 *     "journey from S" framing), then scale non-uniformly (independently
 *     per axis, since this is a schematic diagram rather than a
 *     geographic map) to fill the SVG canvas with margins, and round to
 *     whole pixels.
 *
 * The coordinates currently in dijkstra.js's NODES object are this
 * script's output at the parameters below, unmodified except for
 * whitespace/formatting - re-running it reproduces them exactly (the
 * simulation itself is fully deterministic: no randomness anywhere).
 */

const NODE_ORDER = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const EDGES = [
  ['S', 'A', 10], ['S', 'B', 2], ['S', 'C', 20],
  ['B', 'A', 1], ['B', 'D', 10], ['B', 'E', 13],
  ['A', 'C', 2], ['A', 'F', 10],
  ['C', 'F', 2], ['C', 'G', 9],
  ['F', 'H', 3],
  ['D', 'G', 2],
  ['G', 'H', 4],
  ['E', 'H', 8],
];

const adjacency = {};
NODE_ORDER.forEach(n => adjacency[n] = []);
EDGES.forEach(([a, b, w]) => { adjacency[a].push([b, w]); adjacency[b].push([a, w]); });

// --- Step 1: BFS layering from S for a sane initial seed -----------------
function bfsLayers() {
  const layer = { S: 0 };
  const queue = ['S'];
  while (queue.length) {
    const n = queue.shift();
    adjacency[n].forEach(([m]) => {
      if (!(m in layer)) { layer[m] = layer[n] + 1; queue.push(m); }
    });
  }
  return layer;
}
const layers = bfsLayers();
const byLayer = {};
NODE_ORDER.forEach(n => { (byLayer[layers[n]] = byLayer[layers[n]] || []).push(n); });

const pos = {};
Object.keys(byLayer).forEach(l => {
  const nodesInLayer = byLayer[l];
  nodesInLayer.forEach((n, i) => {
    pos[n] = {
      x: Number(l) * 180,
      y: (i - (nodesInLayer.length - 1) / 2) * 160,
    };
  });
});

// --- Step 2: force simulation --------------------------------------------
const REPULSION = 90000;
const SPRING_K = 0.018;
const CENTER_K = 0.003;
const REST_BASE = 100;
const REST_PER_SQRT_WEIGHT = 18;
const ITERATIONS = 5000;

function restLength(w) { return REST_BASE + REST_PER_SQRT_WEIGHT * Math.sqrt(w); }

for (let iter = 0; iter < ITERATIONS; iter++) {
  const disp = {};
  NODE_ORDER.forEach(n => disp[n] = { x: 0, y: 0 });

  // All-pairs repulsion.
  for (let i = 0; i < NODE_ORDER.length; i++) {
    for (let j = i + 1; j < NODE_ORDER.length; j++) {
      const a = NODE_ORDER[i], b = NODE_ORDER[j];
      const dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
      const dist = Math.max(Math.hypot(dx, dy), 1);
      const force = REPULSION / (dist * dist);
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      disp[a].x += fx; disp[a].y += fy;
      disp[b].x -= fx; disp[b].y -= fy;
    }
  }

  // Per-edge weighted springs.
  EDGES.forEach(([a, b, w]) => {
    const dx = pos[b].x - pos[a].x, dy = pos[b].y - pos[a].y;
    const dist = Math.max(Math.hypot(dx, dy), 1);
    const rest = restLength(w);
    const force = SPRING_K * (dist - rest);
    const fx = (dx / dist) * force, fy = (dy / dist) * force;
    disp[a].x += fx; disp[a].y += fy;
    disp[b].x -= fx; disp[b].y -= fy;
  });

  // Gentle centering pull.
  NODE_ORDER.forEach(n => {
    disp[n].x -= pos[n].x * CENTER_K;
    disp[n].y -= pos[n].y * CENTER_K;
  });

  const cooling = Math.max(0.03, 1 - iter / ITERATIONS);
  NODE_ORDER.forEach(n => {
    pos[n].x += disp[n].x * cooling;
    pos[n].y += disp[n].y * cooling;
  });
}

// --- Step 3: post-process (rotate so S->centroid points rightward,
// scale non-uniformly into the canvas, round) ------------------------
function centroidOfOthers() {
  let cx = 0, cy = 0, n = 0;
  NODE_ORDER.forEach(k => { if (k !== 'S') { cx += pos[k].x; cy += pos[k].y; n++; } });
  return { x: cx / n, y: cy / n };
}
const c = centroidOfOthers();
const angle = Math.atan2(c.y - pos.S.y, c.x - pos.S.x);
const cosA = Math.cos(-angle), sinA = Math.sin(-angle);
NODE_ORDER.forEach(n => {
  const dx = pos[n].x - pos.S.x, dy = pos[n].y - pos.S.y;
  pos[n] = { x: pos.S.x + dx * cosA - dy * sinA, y: pos.S.y + dx * sinA + dy * cosA };
});

// Bounding box -> fit into the app's SVG canvas (viewBox "0 0 660 430")
// with ~55px margins. Scaled independently per axis (not uniformly) so
// the layout actually fills the whole canvas instead of leaving one
// dimension sparse - this is a schematic diagram, not a geographic map,
// so non-uniform scaling (which distorts relative distances a little) is
// the right trade for making full use of the available space.
const MARGIN_X = 55, MARGIN_Y = 55;
const CANVAS_W = 660, CANVAS_H = 430;
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
NODE_ORDER.forEach(n => {
  minX = Math.min(minX, pos[n].x); maxX = Math.max(maxX, pos[n].x);
  minY = Math.min(minY, pos[n].y); maxY = Math.max(maxY, pos[n].y);
});

const scaleX = (CANVAS_W - 2 * MARGIN_X) / (maxX - minX);
const scaleY = (CANVAS_H - 2 * MARGIN_Y) / (maxY - minY);

const final = {};
NODE_ORDER.forEach(n => {
  final[n] = {
    x: Math.round(MARGIN_X + (pos[n].x - minX) * scaleX),
    y: Math.round(MARGIN_Y + (pos[n].y - minY) * scaleY),
  };
});

console.log(JSON.stringify(final, null, 2));

// --- Sanity diagnostics ------------------------------------------------
console.log('\n--- pairwise node distances (min should be well over ~100) ---');
let minPair = Infinity, minPairNodes = null;
for (let i = 0; i < NODE_ORDER.length; i++) {
  for (let j = i + 1; j < NODE_ORDER.length; j++) {
    const a = NODE_ORDER[i], b = NODE_ORDER[j];
    const d = Math.hypot(final[a].x - final[b].x, final[a].y - final[b].y);
    if (d < minPair) { minPair = d; minPairNodes = [a, b]; }
  }
}
console.log('closest pair:', minPairNodes, minPair.toFixed(1));

console.log('\n--- edge lengths (loosely tracks weight - repulsion/topology also shape it) ---');
EDGES.forEach(([a, b, w]) => {
  const d = Math.hypot(final[a].x - final[b].x, final[a].y - final[b].y);
  console.log(`${a}-${b} (w=${w}): ${d.toFixed(1)}px`);
});
