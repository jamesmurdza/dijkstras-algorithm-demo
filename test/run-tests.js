/*
 * test/run-tests.js
 * ------------------
 * Plain-Node correctness tests for dijkstra.js and routing.js. No test
 * framework dependency is needed - this repo is a static, dependency-free
 * web demo, so the test harness is a small self-contained assertion script.
 *
 * Run with:  node test/run-tests.js
 */

var path = require('path');
var dijkstra = require(path.join(__dirname, '..', 'dijkstra.js'));

// routing.js is written as a plain browser <script> (like dijkstra.js): it
// references NODES/START_NODE/pathTo/edgeKey/NODE_RADIUS as bare globals
// rather than importing them, because in the browser dijkstra.js and
// routing.js share one global scope via two <script> tags. To load it
// under plain Node, we copy dijkstra's exports onto Node's `global` object
// first so those bare references resolve the same way they do in a page.
Object.assign(global, dijkstra);
var routing = require(path.join(__dirname, '..', 'routing.js'));

var failures = 0;
var passes = 0;

function assert(condition, message) {
  if (condition) {
    passes++;
  } else {
    failures++;
    console.error('FAIL: ' + message);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message + ' (expected ' + expected + ', got ' + actual + ')');
}

var frames = dijkstra.computeFrames('S');
var finalFrame = frames[frames.length - 1];

// -----------------------------------------------------------------
// 1. Final distances must match the mathematically correct shortest
//    distances for every node.
// -----------------------------------------------------------------
var expectedFinal = { S: 0, B: 2, A: 3, C: 5, F: 7, H: 10, D: 12, G: 14, E: 15 };
Object.keys(expectedFinal).forEach(function (node) {
  assertEqual(finalFrame.dist[node], expectedFinal[node], 'final distance of ' + node);
});

// -----------------------------------------------------------------
// 2. Every node must end up visited, and the frame sequence must end
//    with a 'done' frame.
// -----------------------------------------------------------------
Object.keys(dijkstra.NODES).forEach(function (node) {
  assert(finalFrame.visited[node] === true, node + ' should be visited in the final frame');
});
assertEqual(finalFrame.type, 'done', 'last frame type');

// -----------------------------------------------------------------
// 3. Predecessor-consistency invariant: for every non-source node,
//    dist[v] === dist[prev[v]] + weight(prev[v], v). This is the
//    mathematical definition of a correct shortest-path tree - if this
//    holds for all nodes, the whole tree (not just the raw numbers) is
//    correct, not just coincidentally matching expected numbers.
// -----------------------------------------------------------------
Object.keys(dijkstra.NODES).forEach(function (node) {
  if (node === dijkstra.START_NODE) return;
  var p = finalFrame.prev[node];
  assert(p !== null, node + ' should have a predecessor');
  if (p === null) return;
  var w = dijkstra.edgeWeight(p, node);
  assertEqual(finalFrame.dist[node], finalFrame.dist[p] + w,
    'predecessor-consistency for ' + node + ' via ' + p);
});

// -----------------------------------------------------------------
// 4. Reconstructed best-known paths for every node must be legal walks
//    (each consecutive pair must actually be a graph edge) and must sum
//    to the reported distance.
// -----------------------------------------------------------------
Object.keys(dijkstra.NODES).forEach(function (node) {
  var p = dijkstra.pathTo(node, finalFrame.dist, finalFrame.prev);
  assert(p !== null, 'path to ' + node + ' should be reconstructible');
  if (!p) return;
  assertEqual(p[0], 'S', 'path to ' + node + ' should start at S');
  assertEqual(p[p.length - 1], node, 'path to ' + node + ' should end at ' + node);
  var sum = 0;
  for (var i = 0; i < p.length - 1; i++) {
    var w = dijkstra.edgeWeight(p[i], p[i + 1]);
    assert(w !== null, 'edge ' + p[i] + '-' + p[i + 1] + ' must exist in the graph');
    sum += w;
  }
  assertEqual(sum, finalFrame.dist[node], 'summed edge weights along path to ' + node);
});

// -----------------------------------------------------------------
// 5. The required "shortcut discovery" milestones must actually occur,
//    in order, as distinct relaxation results within a visit's
//    `relaxations` list - proving the UI is showing a live algorithm run
//    rather than a scripted animation. (Each step is now a full node
//    visit - selection plus all of its edge relaxations at once - rather
//    than one micro-step per edge, so we search inside `relaxations`.)
// -----------------------------------------------------------------
function findRelax(fromTo, reason, newDist) {
  var to = fromTo.split('->')[1];
  return frames.findIndex(function (f) {
    return f.type === 'visit' && f.relaxations.some(function (r) {
      return r.from + '->' + r.to === fromTo && r.reason === reason && r.newDist === newDist;
    }) && f.dist[to] === newDist;
  });
}

var milestones = [
  ['S->A', 'discovered', 10, 'A first discovered at 10 via S'],
  ['S->C', 'discovered', 20, 'C first discovered at 20 via S'],
  ['B->A', 'improved', 3, 'A improved to 3 via S->B->A'],
  ['A->C', 'improved', 5, 'C improved to 5 via S->B->A->C'],
  ['A->F', 'discovered', 13, 'F first discovered at 13 via S->B->A->F'],
  ['C->F', 'improved', 7, 'F improved to 7 via S->B->A->C->F'],
  ['F->H', 'discovered', 10, 'H discovered at 10 via F'],
];

var lastIndex = -1;
milestones.forEach(function (m) {
  var idx = findRelax(m[0], m[1], m[2]);
  assert(idx !== -1, 'milestone missing: ' + m[3]);
  // A single step now performs a whole node visit (selection + relaxing
  // ALL of its outgoing edges at once), so two milestones can legitimately
  // land in the very same frame (e.g. S discovering both A and C in one
  // step) - order only needs to be non-decreasing, not strictly increasing.
  assert(idx >= lastIndex, 'milestone out of order: ' + m[3]);
  lastIndex = Math.max(lastIndex, idx);
});

// Sanity: H's final predecessor must indeed be F (not G or E).
assertEqual(finalFrame.prev.H, 'F', "H's final predecessor should be F");

// -----------------------------------------------------------------
// 6. Paths must change immediately when a predecessor changes: after
//    the 'improved' frame for A (B->A), the path shown for A must no
//    longer include the old S->A edge.
// -----------------------------------------------------------------
var improvedAIdx = findRelax('B->A', 'improved', 3);
var frameAfterImprove = frames[improvedAIdx];
var aPath = dijkstra.pathTo('A', frameAfterImprove.dist, frameAfterImprove.prev);
assertEqual(aPath.join(','), 'S,B,A', "A's path immediately after improvement should be S,B,A");

// -----------------------------------------------------------------
// 7. Wrap-around geometry (routing.js): every intermediate node a route
//    passes through now wraps the LONG way around the node on its own
//    concentric ring instead of cutting a short corner. Two circles of
//    different radii around the same center can never intersect, so the
//    arcs themselves are automatically safe - the real risk is a route's
//    short lead-in/lead-out transition (peeling off its straight lane
//    onto its ring, or back off again) clipping through a SMALLER ring's
//    arc on its way past it. This is checked numerically below by
//    sampling every transition line (the exact same taper geometry
//    routing.js renders, via its exported bendPoints()) and confirming
//    it never lands on another destination's arc, for every node in
//    every one of the 11 frames - not just the handful of cases worked
//    out by hand while designing the heuristic.
//
//    Two kinds of "touch" are expected and NOT counted as crossings:
//      (a) two routes in the SAME group (identical next node, so
//          identical vIn/vOut) are provably safe to stack at any radius
//          - same fixed destination-order sort drives both their
//          straight-lane offset AND their ring assignment, so they nest
//          like non-crossing parentheses instead of tangling.
//      (b) EVERY route at a node - regardless of group - shares the
//          exact same incoming angle (vIn), since they all arrive via
//          the same predecessor tree edge. Their taper-in lines
//          legitimately converge on that shared angle near the node;
//          that is the expected entry corridor, not a collision.
// -----------------------------------------------------------------
var TWO_PI = Math.PI * 2;

function normAngle(a) { return ((a % TWO_PI) + TWO_PI) % TWO_PI; }

function angleOf(v) { return Math.atan2(v.y, v.x); }

function angleDelta(a, b) {
  var d = Math.abs(normAngle(a) - normAngle(b));
  return Math.min(d, TWO_PI - d);
}

// Is `angle` inside the arc that runs from `loAngle` increasing (mod 2*PI)
// up to `hiAngle`? (Wraps through 0 if loAngle > hiAngle.)
function angleInIncreasingRange(angle, loAngle, hiAngle, eps) {
  angle = normAngle(angle); loAngle = normAngle(loAngle); hiAngle = normAngle(hiAngle);
  if (loAngle <= hiAngle) return angle >= loAngle - eps && angle <= hiAngle + eps;
  return angle >= loAngle - eps || angle <= hiAngle + eps;
}

// Does `angle` lie on the arc this wrap actually draws (entry -> exit,
// travelling in the direction its sweepFlag encodes)?
function angleOnWrapArc(angle, wrap, eps) {
  var entry = angleOf(wrap.vIn), exit = angleOf(wrap.vOut);
  return wrap.sweepFlag === 1
    ? angleInIncreasingRange(angle, entry, exit, eps)
    : angleInIncreasingRange(angle, exit, entry, eps);
}

function linePoint(p0, p1, t) {
  return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
}

var RADIUS_EPS = 2; // px - must be well under LANE_SPACING (6) so adjacent rings aren't confused
var ANGLE_EPS = 3 * Math.PI / 180; // ~3 degrees of slack at an arc's own boundary
var ENTRY_CORRIDOR_EPS = 20 * Math.PI / 180; // shared vIn corridor - see note (b) above
var SAMPLES = 40;

var crossingsFound = 0;

frames.forEach(function (frame, frameIdx) {
  var usage = routing.collectEdgeUsage(frame);
  var wraps = routing.computeNodeWraps(frame);

  Object.keys(wraps).forEach(function (nodeKey) {
    var nodeWraps = wraps[nodeKey];
    var center = dijkstra.NODES[nodeKey];
    var dests = Object.keys(nodeWraps);
    var sharedInAngle = angleOf(nodeWraps[dests[0]].vIn); // identical for every dest at this node

    // Ring radii must all be distinct at a given node (that's what makes
    // the arcs themselves automatically non-intersecting).
    var radii = dests.map(function (d) { return nodeWraps[d].radius; });
    assertEqual(new Set(radii).size, radii.length,
      'frame ' + frameIdx + ' node ' + nodeKey + ': ring radii must be unique');

    dests.forEach(function (destNode) {
      var wrap = nodeWraps[destNode];
      assert(wrap.sweepFlag === 0 || wrap.sweepFlag === 1,
        'frame ' + frameIdx + ' node ' + nodeKey + ' ' + destNode + ': sweepFlag must be 0 or 1');
      assert(isFinite(wrap.radius) && wrap.radius > NODE_RADIUS,
        'frame ' + frameIdx + ' node ' + nodeKey + ' ' + destNode + ': radius must be a finite number beyond the node');

      var built = routing.buildLaneSegments(frame, usage, destNode);
      var i = built.path.indexOf(nodeKey);
      // i is guaranteed > 0 and < path.length-1 since this destination
      // has a wrap entry at this node (it's an interior waypoint there).
      var bend = routing.bendPoints(center, wrap, built.segments[i - 1].end, built.segments[i].start);

      var transitions = [
        { from: bend.taperInFrom, to: bend.arcEntry },
        { from: bend.arcExit, to: bend.taperOutTo },
      ];

      transitions.forEach(function (transition) {
        for (var s = 1; s < SAMPLES; s++) { // skip endpoints - they're the expected touch points
          var t = s / SAMPLES;
          var p = linePoint(transition.from, transition.to, t);
          var sampleRadius = Math.hypot(p.x - center.x, p.y - center.y);
          var sampleAngle = Math.atan2(p.y - center.y, p.x - center.x);

          // (b) shared entry corridor - see header comment.
          if (angleDelta(sampleAngle, sharedInAngle) < ENTRY_CORRIDOR_EPS) return;

          dests.forEach(function (otherDest) {
            if (otherDest === destNode) return;
            var otherWrap = nodeWraps[otherDest];
            // (a) same-group pairs - see header comment.
            if (otherWrap.nextNode === wrap.nextNode) return;
            if (Math.abs(sampleRadius - otherWrap.radius) > RADIUS_EPS) return;
            if (angleOnWrapArc(sampleAngle, otherWrap, ANGLE_EPS)) {
              crossingsFound++;
              console.error('CROSSING: frame ' + frameIdx + ' node ' + nodeKey + ' - ' +
                destNode + '\'s transition crosses ' + otherDest + '\'s arc at radius~' +
                Math.round(sampleRadius) + ', angle~' + Math.round(sampleAngle * 180 / Math.PI) + '°');
            }
          });
        }
      });
    });
  });
});

assertEqual(crossingsFound, 0, 'no destination\'s node-wrap transition should cross another destination\'s wrap arc, across all frames');

// -----------------------------------------------------------------
// Report
// -----------------------------------------------------------------
console.log(passes + ' passed, ' + failures + ' failed (out of ' + (passes + failures) + ' assertions)');
console.log('Total frames generated: ' + frames.length);
if (failures > 0) {
  process.exit(1);
}
