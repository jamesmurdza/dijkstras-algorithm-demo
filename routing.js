/*
 * routing.js
 * ----------
 * "Subway map" path-routing logic: turns the current Dijkstra frame
 * (distances + predecessors) into SVG path data for each destination's
 * colored shortest-path line, WITHOUT letting distinct routes render on
 * top of each other when they share a graph edge.
 *
 * THE CORE IDEA ("parallel tracks"):
 * Real subway diagrams never draw two lines exactly on top of each other
 * even when two train lines share the same stretch of track - they draw
 * them as thin parallel lines offset a few pixels apart, converging and
 * diverging smoothly at stations. We do the same thing here:
 *
 *   1. For the CURRENT frame, walk every destination's predecessor chain
 *      back to S to get its full path (an ordered list of node keys).
 *   2. For every graph edge that appears in at least one path, collect
 *      *which* destinations currently route through it ("edge usage").
 *   3. Sort that list by a fixed node order (A, B, C, ... H) and give
 *      each destination a "lane index" on that edge - this is what
 *      spaces routes out into parallel, non-overlapping tracks with
 *      consistent spacing, and keeps a given destination's lane
 *      assignment stable relative to the others sharing that edge.
 *   4. Offset each edge segment sideways (perpendicular to the ACTUAL
 *      direction that edge is walked in, from -> to) by
 *      (laneIndex - middle) * LANE_SPACING pixels. Every route walks a
 *      shared edge in the same direction (this is a shortest-path TREE,
 *      so an edge only ever points "child-ward" one way at a time), so
 *      this still keeps every lane on that edge parallel - but it also
 *      means a lane's offset sign consistently means "to the left of the
 *      direction of travel" for the WHOLE route, at every edge, like a
 *      "keep to your left" rule for someone walking the path from S
 *      onward. See travelPerp() below for why that consistency matters.
 *   5. Stitch the offset segments back together with straight runs
 *      between nodes and small quadratic-bezier "rounded corners" at
 *      every intermediate node the path passes through, so bends look
 *      controlled and deliberate instead of jagged. Each path starts
 *      and ends by curving exactly into its endpoint node's center, so
 *      it is always visually obvious which nodes a route connects.
 *
 * Because this is recomputed from `frame.dist` / `frame.prev` on every
 * single step, a path is redrawn (and can jump to a completely different
 * set of edges/lanes) the instant a predecessor changes - there is no
 * cached/precomputed "final" drawing.
 */

var LANE_SPACING = 6; // px between adjacent parallel lanes on a shared edge

// ---------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------
function vecSub(p, q) { return { x: p.x - q.x, y: p.y - q.y }; }
function vecLen(v) { return Math.hypot(v.x, v.y) || 1; }
function vecNorm(v) { var l = vecLen(v); return { x: v.x / l, y: v.y / l }; }
// Perpendicular (rotate 90 degrees) of a unit vector.
function vecPerp(v) { return { x: -v.y, y: v.x }; }

// Perpendicular unit vector for a segment, computed from the ACTUAL
// direction this destination travels it (from -> to), not from some
// arbitrary per-edge convention (e.g. alphabetical node order). Because
// every route walks a shared edge in the same direction (it's a
// shortest-path TREE - an edge is only ever "child-ward" from one
// specific side at a time), every destination using this edge computes
// the exact same perpendicular here too, so lanes still line up in
// parallel exactly like before.
//
// The reason this matters: a lane's offset sign now means "consistently
// to the left of the direction of travel" for the ENTIRE route, at every
// edge it crosses - like a "keep to your left" rule for someone walking
// the path from S onward - rather than a sign that can happen to flip
// depending on each edge's own arbitrary alphabetical convention. Before
// this, a lane could be offset to (say) the right of one edge and the
// left of the very next edge purely because of how their endpoint names
// happened to sort, which is what made bundles cross through each other
// at a bend instead of sweeping through it together as a coherent group.
function travelPerp(from, to) {
  return vecPerp(vecNorm(vecSub(NODES[to], NODES[from])));
}

// ---------------------------------------------------------------------
// Step 1-3: figure out, for the given frame, which destinations use
// which edges, and assign each a lane index on that edge.
// ---------------------------------------------------------------------
function collectEdgeUsage(frame) {
  var usage = {}; // edgeKey -> [destNode, destNode, ...] sorted by NODES[].order

  Object.keys(NODES).forEach(function (node) {
    if (node === START_NODE) return; // S has no "path", it's the origin
    if (frame.dist[node] === Infinity) return; // not discovered yet

    var path = pathTo(node, frame.dist, frame.prev);
    if (!path) return;

    for (var i = 0; i < path.length - 1; i++) {
      var key = edgeKey(path[i], path[i + 1]);
      if (!usage[key]) usage[key] = [];
      usage[key].push(node);
    }
  });

  Object.keys(usage).forEach(function (key) {
    usage[key].sort(function (a, b) { return NODES[a].order - NODES[b].order; });
  });

  return usage;
}

function laneOffset(usageList, destNode) {
  var idx = usageList.indexOf(destNode);
  var n = usageList.length;
  // Centered offsets: e.g. for 3 lanes -> [-1, 0, 1] * spacing
  return (idx - (n - 1) / 2) * LANE_SPACING;
}

// ---------------------------------------------------------------------
// Step 4-5: build the actual SVG path "d" string for one destination.
// Returns null when the destination has not been discovered yet in this
// frame (nothing to draw).
// ---------------------------------------------------------------------
function buildDestinationPathD(frame, usage, destNode) {
  var path = pathTo(destNode, frame.dist, frame.prev);
  if (!path || path.length < 2) return null;

  // One offset "lane segment" (parallel to the real edge) per hop. The
  // usage-list lookup still uses the canonical (sorted) edge key - that's
  // just a dictionary key for grouping, it has no geometric meaning - but
  // the offset direction itself now comes from travelPerp(from, to), the
  // real direction of travel, so a lane's relative side is consistent
  // for the whole route rather than reset per edge (see travelPerp above).
  var segments = path.slice(0, -1).map(function (from, i) {
    var to = path[i + 1];
    var sorted = [from, to].sort();
    var key = sorted[0] + '-' + sorted[1];
    var offset = laneOffset(usage[key], destNode);
    var perp = travelPerp(from, to);
    var ox = perp.x * offset, oy = perp.y * offset;
    var a = NODES[from], b = NODES[to];
    return {
      start: { x: a.x + ox, y: a.y + oy },
      end: { x: b.x + ox, y: b.y + oy },
    };
  });

  var startNode = NODES[path[0]]; // always S
  var d = 'M ' + startNode.x + ' ' + startNode.y;

  // Curve out from S's exact center into the first lane.
  var first = segments[0];
  d += ' Q ' + midpoint(startNode, first.start) + ' ' + pt(first.start);
  d += ' L ' + pt(first.end);

  // Straight lane run for each subsequent edge, joined by a rounded
  // corner (a quadratic bezier "pulled" toward the real node position)
  // at every intermediate node the path passes through.
  for (var i = 1; i < segments.length; i++) {
    var node = NODES[path[i]];
    d += ' Q ' + pt(node) + ' ' + pt(segments[i].start);
    d += ' L ' + pt(segments[i].end);
  }

  // Curve into the destination node's exact center so the route
  // visibly terminates at the right place.
  var lastEnd = segments[segments.length - 1].end;
  var dest = NODES[destNode];
  d += ' Q ' + midpoint(lastEnd, dest) + ' ' + pt(dest);

  return d;
}

function pt(p) { return round(p.x) + ' ' + round(p.y); }
function midpoint(a, b) { return round((a.x + b.x) / 2) + ' ' + round((a.y + b.y) / 2); }
function round(n) { return Math.round(n * 10) / 10; }

// Convenience: build { destNode: dValue } for every currently-discovered
// destination in one call, ready to hand to the SVG renderer.
function buildAllPaths(frame) {
  var usage = collectEdgeUsage(frame);
  var out = {};
  Object.keys(NODES).forEach(function (node) {
    if (node === START_NODE) return;
    var d = buildDestinationPathD(frame, usage, node);
    if (d) out[node] = d;
  });
  return out;
}
