/*
 * test/run-tests.js
 * ------------------
 * Plain-Node correctness tests for dijkstra.js. No test framework
 * dependency is needed - this repo is a static, dependency-free web demo,
 * so the test harness is a small self-contained assertion script.
 *
 * Run with:  node test/run-tests.js
 */

var path = require('path');
var dijkstra = require(path.join(__dirname, '..', 'dijkstra.js'));

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
//    in order, as distinct relax events - proving the UI is showing a
//    live algorithm run rather than a scripted animation.
// -----------------------------------------------------------------
function findRelax(fromTo, reason, newDist) {
  return frames.findIndex(function (f) {
    return f.type === 'relax' &&
      f.activeEdge &&
      f.activeEdge.from + '->' + f.activeEdge.to === fromTo &&
      f.activeEdge.reason === reason &&
      f.dist[fromTo.split('->')[1]] === newDist;
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
  assert(idx > lastIndex, 'milestone out of order: ' + m[3]);
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
// Report
// -----------------------------------------------------------------
console.log(passes + ' passed, ' + failures + ' failed (out of ' + (passes + failures) + ' assertions)');
console.log('Total frames generated: ' + frames.length);
if (failures > 0) {
  process.exit(1);
}
