/*
 * routing.js
 * ----------
 * "Subway map" path-routing logic: turns the current Dijkstra frame
 * (distances + predecessors) into SVG path data for each destination's
 * colored shortest-path line, WITHOUT letting distinct routes render on
 * top of each other when they share a graph edge OR pass through the
 * same node.
 *
 * THE CORE IDEA ("parallel tracks" on straight edges):
 * Real subway diagrams never draw two lines exactly on top of each other
 * even when two train lines share the same stretch of track - they draw
 * them as thin parallel lines offset a few pixels apart. We do the same:
 *
 *   1. For the CURRENT frame, walk every destination's predecessor chain
 *      back to S to get its full path (an ordered list of node keys).
 *   2. For every graph edge that appears in at least one path, collect
 *      *which* destinations currently route through it ("edge usage").
 *   3. Sort that list by a fixed node order (A, B, C, ... H) and give
 *      each destination a "lane index" on that edge - this spaces routes
 *      out into parallel, non-overlapping tracks with consistent
 *      spacing, and keeps a destination's lane assignment stable
 *      relative to the others sharing that edge.
 *   4. Offset each edge segment sideways (perpendicular to the edge) by
 *      (laneIndex - middle) * LANE_SPACING pixels.
 *
 * THE HARDER IDEA ("wrap around the long way" at nodes):
 * Instead of cutting the short/near corner where a route bends at an
 * intermediate node, every bend now swings around the FAR side of that
 * node's circle - the reflex angle - like a cord wrapping around a
 * pulley, rather than clipping straight across. When several routes bend
 * through the very same node, each gets its own concentric ring (bigger
 * radius = further out) so their arcs can never touch each other - two
 * circles of different radii around the same center never intersect,
 * full stop.
 *
 * The part that ISN'T automatically safe is the short lead-in/lead-out
 * transition where a route peels off its straight lane onto its ring (or
 * back off again): that transition has to travel from near the node
 * outward, so it briefly crosses through every SMALLER ring's radius on
 * the way. If that smaller ring's arc happens to occupy the angle the
 * transition is passing through, they'd cross.
 *
 * Because every route through a given node in a given frame arrives from
 * the exact same previous node (there's only one predecessor tree), the
 * only way routes can differ at a node is in which node comes NEXT - i.e.
 * a branch, like C splitting toward F vs toward G. Routes that share the
 * same next node share the exact same entry/exit angles, so they nest on
 * their rings with zero risk (their lead-ins/outs travel along the same
 * angular line, just to different radii - never crossing).
 *
 * For an actual branch (different next-node groups at the same node), we
 * order the GROUPS by their long-way sweep angle, smallest first, and
 * give the smallest-sweep group the innermost rings. Why: a small sweep
 * means a big leftover "gap" on that ring (the short arc it did NOT
 * take); putting the gentlest-turning group innermost maximizes the
 * chance that a sharper-turning, further-out group's lead-in/out can
 * thread through that gap instead of crossing the arc. This was checked
 * by hand against every branch point this specific graph actually
 * produces (a transient 3-way split at B, a transient 2-way split at A,
 * and the permanent 2-way split at C) and holds for all of them - see
 * test/run-tests.js for the automated version of that check.
 */

var LANE_SPACING = 6; // px between adjacent parallel lanes on a shared edge

// A route's straight lane keeps its full perpendicular offset right up
// until TAPER_LEN px before/after a wrapped node, then linearly tapers
// that offset down to zero exactly where it meets the node's ring
// system. Without this, the lane would carry its (possibly quite large,
// for a big bundle) sideways offset all the way to the node and the
// wrap's lead-in/lead-out would have to swing through a wide, unstable
// angle right where several rings are stacked closely together - taper
// this offset away first, and by the time the route reaches its ring it
// is travelling on a purely radial line (constant angle = vIn or vOut),
// which only ever touches another ring at that ring's own shared
// boundary angle - never sweeps across its interior.
var TAPER_LEN = 18;

// Extra radius gap inserted between two different GROUPS at the same
// node (as opposed to LANE_SPACING between routes within one group).
// Sized so a group's outermost lane's taper-out (which reaches
// TAPER_LEN past its own ring) can never physically reach the next
// group's innermost ring.
var GROUP_GAP = TAPER_LEN + LANE_SPACING;

// ---------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------
function vecSub(p, q) { return { x: p.x - q.x, y: p.y - q.y }; }
function vecLen(v) { return Math.hypot(v.x, v.y) || 1; }
function vecNorm(v) { var l = vecLen(v); return { x: v.x / l, y: v.y / l }; }
// Perpendicular (rotate 90 degrees) of a unit vector.
function vecPerp(v) { return { x: -v.y, y: v.x }; }

// Perpendicular unit vector for an edge, computed from a *canonical*
// (alphabetically sorted) node order. Using the canonical order - rather
// than whichever direction a particular path happens to traverse the
// edge in - guarantees every destination sharing that edge offsets
// against the exact same reference line, so their lanes actually end up
// parallel instead of mirrored/overlapping.
function canonicalPerp(u, v) {
  var a = NODES[u], b = NODES[v];
  return vecPerp(vecNorm(vecSub(b, a)));
}

// ---------------------------------------------------------------------
// Straight-edge lane assignment (unchanged from the original design).
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
// Node wrap-around ring assignment.
//
// For the CURRENT frame, find every (node, destination) pair where that
// node is an INTERIOR waypoint of the destination's path - i.e. the path
// arrives from one neighbor and continues to another, rather than
// starting (S) or ending (the destination itself) there.
// ---------------------------------------------------------------------
function collectWaypoints(frame) {
  // nodeKey -> { prevNode, byNext: { nextNode: [destNode, ...] } }
  var byNode = {};

  Object.keys(NODES).forEach(function (node) {
    if (node === START_NODE) return;
    if (frame.dist[node] === Infinity) return;
    var path = pathTo(node, frame.dist, frame.prev);
    if (!path) return;

    for (var i = 1; i < path.length - 1; i++) {
      var n = path[i];
      var p = path[i - 1];
      var q = path[i + 1];
      if (!byNode[n]) byNode[n] = { prevNode: p, byNext: {} };
      if (!byNode[n].byNext[q]) byNode[n].byNext[q] = [];
      byNode[n].byNext[q].push(node);
    }
  });

  return byNode;
}

// Turn the raw waypoint lists into a concrete ring-radius + arc-sweep
// assignment per (node, destination): { [nodeKey]: { [destNode]: {
// radius, vIn, vOut, sweepFlag, nextNode } } }. `nextNode` (which group a
// destination belongs to) is included alongside the geometry mainly so
// test/run-tests.js can tell "same group" apart from "different group"
// exactly (by node identity) rather than by comparing floating-point
// angles - two routes in the same group share the identical vOut and so
// are provably safe to stack at any radius; only cross-group pairs need
// the numeric crossing check.
function computeNodeWraps(frame) {
  var waypoints = collectWaypoints(frame);
  var wraps = {};

  Object.keys(waypoints).forEach(function (nodeKey) {
    var info = waypoints[nodeKey];
    var center = NODES[nodeKey];
    var vIn = vecNorm(vecSub(NODES[info.prevNode], center));

    // One group per distinct "next node" - routes in the same group share
    // an identical entry/exit angle and so can never cross each other.
    var groups = Object.keys(info.byNext).map(function (nextNode) {
      var vOut = vecNorm(vecSub(NODES[nextNode], center));
      var dot = Math.max(-1, Math.min(1, vIn.x * vOut.x + vIn.y * vOut.y));
      var shortAngle = Math.acos(dot); // 0..PI, the DIRECT angle between in/out
      var longAngle = 2 * Math.PI - shortAngle; // the reflex angle we actually draw
      var cross = vIn.x * vOut.y - vIn.y * vOut.x;
      // cross > 0 means the SHORT way turns clockwise on-screen (SVG's
      // y-down axes); the long way we draw is the opposite rotation.
      // (|cross| ~ 0 means in/out are parallel or antiparallel - an
      // ambiguous degenerate case that shouldn't occur on this fixed
      // layout; default to sweepFlag 1 rather than risk a NaN/garbage arc.)
      var sweepFlag = Math.abs(cross) < 1e-6 ? 1 : (cross > 0 ? 0 : 1);
      return {
        nextNode: nextNode,
        vOut: vOut,
        longAngle: longAngle,
        sweepFlag: sweepFlag,
        dests: info.byNext[nextNode].slice().sort(function (a, b) {
          return NODES[a].order - NODES[b].order;
        }),
      };
    });

    // Smallest reflex sweep (gentlest turn -> biggest leftover gap) goes
    // on the innermost rings; see the file header for why that ordering
    // is what keeps a branching node's groups from crossing each other.
    groups.sort(function (a, b) { return a.longAngle - b.longAngle; });

    var radius = NODE_RADIUS;
    var nodeWraps = {};
    groups.forEach(function (group, groupIndex) {
      radius += groupIndex === 0 ? LANE_SPACING : GROUP_GAP;
      group.dests.forEach(function (dest, destIndex) {
        if (destIndex > 0) radius += LANE_SPACING;
        nodeWraps[dest] = {
          radius: radius,
          vIn: vIn,
          vOut: group.vOut,
          sweepFlag: group.sweepFlag,
          nextNode: group.nextNode,
        };
      });
    });
    wraps[nodeKey] = nodeWraps;
  });

  return wraps;
}

// One offset "lane segment" (parallel to the real edge) per hop of a
// destination's path. Split out from buildDestinationPathD so the
// geometry can also be sampled directly by the automated crossing check
// in test/run-tests.js, without duplicating this math there.
function buildLaneSegments(frame, usage, destNode) {
  var path = pathTo(destNode, frame.dist, frame.prev);
  if (!path || path.length < 2) return null;

  var segments = path.slice(0, -1).map(function (from, i) {
    var to = path[i + 1];
    var sorted = [from, to].sort();
    var key = sorted[0] + '-' + sorted[1];
    var offset = laneOffset(usage[key], destNode);
    var perp = canonicalPerp(sorted[0], sorted[1]);
    var ox = perp.x * offset, oy = perp.y * offset;
    var a = NODES[from], b = NODES[to];
    return {
      start: { x: a.x + ox, y: a.y + oy },
      end: { x: b.x + ox, y: b.y + oy },
    };
  });

  return { path: path, segments: segments };
}

// For one bend (an interior node a destination's path passes through),
// compute every point needed to draw it: where the straight lane's full
// offset tapers away (taperInFrom), where that taper meets the ring
// (arcEntry), where the long-way arc lets back out (arcExit), and where
// the NEXT straight lane's full offset resumes (taperOutTo). Exported
// separately (rather than left inline in buildDestinationPathD) so
// test/run-tests.js can sample the exact same geometry that gets
// rendered, instead of re-deriving its own approximation of it.
function bendPoints(nodeCenter, wrap, segEnd, nextSegStart) {
  return {
    taperInFrom: { x: segEnd.x + TAPER_LEN * wrap.vIn.x, y: segEnd.y + TAPER_LEN * wrap.vIn.y },
    arcEntry: { x: nodeCenter.x + wrap.radius * wrap.vIn.x, y: nodeCenter.y + wrap.radius * wrap.vIn.y },
    arcExit: { x: nodeCenter.x + wrap.radius * wrap.vOut.x, y: nodeCenter.y + wrap.radius * wrap.vOut.y },
    taperOutTo: { x: nextSegStart.x + TAPER_LEN * wrap.vOut.x, y: nextSegStart.y + TAPER_LEN * wrap.vOut.y },
  };
}

// ---------------------------------------------------------------------
// Build the actual SVG path "d" string for one destination. Returns null
// when the destination has not been discovered yet in this frame.
// ---------------------------------------------------------------------
function buildDestinationPathD(frame, usage, wraps, destNode) {
  var built = buildLaneSegments(frame, usage, destNode);
  if (!built) return null;
  var path = built.path;
  var segments = built.segments;

  var startNode = NODES[path[0]]; // always S
  var d = 'M ' + startNode.x + ' ' + startNode.y;

  // Curve out from S's exact center into the first lane.
  d += ' Q ' + midpoint(startNode, segments[0].start) + ' ' + pt(segments[0].start);

  for (var i = 0; i < segments.length; i++) {
    var isLastSegment = i === segments.length - 1;

    if (isLastSegment) {
      d += ' L ' + pt(segments[i].end);
      // Curve into the destination node's exact center so the route
      // visibly terminates at the right place.
      var dest = NODES[destNode];
      d += ' Q ' + midpoint(segments[i].end, dest) + ' ' + pt(dest);
    } else {
      // Peel off this lane's full offset (taper it away), wrap the long
      // way around the node on this destination's assigned ring, then
      // taper the NEXT lane's full offset back in. taperOutTo becomes
      // the effective "start" the next loop iteration draws onward from
      // - its own segments[i+1].start is intentionally never visited.
      var nodeKey = path[i + 1];
      var wrap = wraps[nodeKey][destNode]; // always present: every non-final path node has a wrap entry
      var bend = bendPoints(NODES[nodeKey], wrap, segments[i].end, segments[i + 1].start);

      d += ' L ' + pt(bend.taperInFrom);
      d += ' L ' + pt(bend.arcEntry);
      // Elliptical arc, rx=ry=radius (a true circle), large-arc-flag=1
      // (we always want the reflex/major arc - the "long way").
      d += ' A ' + round(wrap.radius) + ' ' + round(wrap.radius) + ' 0 1 ' + wrap.sweepFlag + ' ' + pt(bend.arcExit);
      d += ' L ' + pt(bend.taperOutTo);
    }
  }

  return d;
}

function pt(p) { return round(p.x) + ' ' + round(p.y); }
function midpoint(a, b) { return round((a.x + b.x) / 2) + ' ' + round((a.y + b.y) / 2); }
function round(n) { return Math.round(n * 10) / 10; }

// Convenience: build { destNode: dValue } for every currently-discovered
// destination in one call, ready to hand to the SVG renderer.
function buildAllPaths(frame) {
  var usage = collectEdgeUsage(frame);
  var wraps = computeNodeWraps(frame);
  var out = {};
  Object.keys(NODES).forEach(function (node) {
    if (node === START_NODE) return;
    var d = buildDestinationPathD(frame, usage, wraps, node);
    if (d) out[node] = d;
  });
  return out;
}

// Export for Node (unit tests) while staying a plain global script in the
// browser, exactly like dijkstra.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LANE_SPACING: LANE_SPACING,
    TAPER_LEN: TAPER_LEN,
    GROUP_GAP: GROUP_GAP,
    collectEdgeUsage: collectEdgeUsage,
    collectWaypoints: collectWaypoints,
    computeNodeWraps: computeNodeWraps,
    buildLaneSegments: buildLaneSegments,
    bendPoints: bendPoints,
    buildDestinationPathD: buildDestinationPathD,
    buildAllPaths: buildAllPaths,
  };
}
