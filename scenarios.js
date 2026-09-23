/*
 * scenarios.js
 * ------------
 * The picker for "which graph is currently active." Each scenario is a
 * complete, self-contained graph definition - nodes (with fixed x/y and
 * a color), weighted edges, and a start node - in exactly the shape
 * dijkstra.js's NODES/EDGES/START_NODE already take. Loading a scenario
 * (see setActiveScenario() in dijkstra.js and loadScenario() in app.js)
 * just swaps those globals out for a different scenario's data and
 * rebuilds the graph/algorithm run from scratch - nothing about the
 * algorithm or rendering logic is scenario-specific.
 *
 * The FIRST scenario intentionally reuses dijkstra.js's own NODES/EDGES/
 * START_NODE objects directly (rather than duplicating that data here) -
 * it's the original graph this whole demo was built around, so it stays
 * defined in dijkstra.js and this just points at it. Every other
 * scenario's coordinates are - like the original's - computed output
 * from tools/generate-layout.js (same force-directed method: BFS-layer
 * seeding, all-pairs repulsion, weight-scaled springs, rotate-so-S-reads-
 * left, scale to fit), just run against that scenario's own edge list
 * instead.
 *
 * Colors reuse the same fixed categorical palette in the same order (S
 * is always the neutral ink color; A, B, C... always get the same color
 * regardless of which scenario is active), so a color keeps meaning
 * "this many hops into the alphabet" across scenarios rather than being
 * reassigned per graph. The first 8 slots (A-H) are the original
 * validated palette; A-L (12 slots, for the larger scenarios below)
 * extends it with 4 more hues chosen and ORDERED the same way the
 * original 8 were - run through dataviz's scripts/validate_palette.js
 * (adjacent-pair CVD ΔE >= 8, normal-vision ΔE >= 15, in both light AND
 * dark mode) rather than picked by eye. Nothing beyond slot 12 has been
 * validated, so no scenario here goes past 12 destinations (13 nodes
 * total) - a 13th color would need its own validation pass first, not a
 * cycled/generated hue (see the skill's non-negotiable: "a 9th series is
 * never a generated hue").
 */
var SCENARIOS = [
  {
    id: 'classic',
    name: 'Classic Commute',
    nodeOrder: ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    nodes: NODES,
    edges: EDGES,
    startNode: START_NODE,
  },
  {
    id: 'compact-grid',
    name: 'Compact Grid',
    nodeOrder: ['S', 'A', 'B', 'C', 'D', 'E'],
    nodes: {
      S: { x: 55, y: 215, color: '#1d1d1b', order: 0 },
      A: { x: 209, y: 55, color: '#2a78d6', order: 1 },
      B: { x: 246, y: 289, color: '#eb6834', order: 2 },
      C: { x: 412, y: 137, color: '#1baf7a', order: 3 },
      D: { x: 450, y: 375, color: '#eda100', order: 4 },
      E: { x: 605, y: 221, color: '#e87ba4', order: 5 },
    },
    edges: [
      ['S', 'A', 4],
      ['S', 'B', 2],
      ['A', 'B', 1],
      ['A', 'C', 5],
      ['B', 'D', 6],
      ['B', 'C', 7],
      ['C', 'D', 2],
      ['C', 'E', 4],
      ['D', 'E', 3],
    ],
    startNode: 'S',
  },
  {
    id: 'dense-network',
    name: 'Dense Network',
    nodeOrder: ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    nodes: {
      S: { x: 55, y: 216, color: '#1d1d1b', order: 0 },
      A: { x: 200, y: 55, color: '#2a78d6', order: 1 },
      B: { x: 218, y: 196, color: '#eb6834', order: 2 },
      C: { x: 228, y: 363, color: '#1baf7a', order: 3 },
      D: { x: 362, y: 61, color: '#eda100', order: 4 },
      E: { x: 492, y: 138, color: '#e87ba4', order: 5 },
      F: { x: 385, y: 261, color: '#008300', order: 6 },
      G: { x: 469, y: 375, color: '#4a3aa7', order: 7 },
      H: { x: 605, y: 274, color: '#e34948', order: 8 },
    },
    edges: [
      ['S', 'A', 3],
      ['S', 'B', 6],
      ['S', 'C', 9],
      ['A', 'B', 2],
      ['A', 'D', 8],
      ['A', 'E', 12],
      ['B', 'C', 3],
      ['B', 'D', 4],
      ['B', 'F', 10],
      ['C', 'F', 5],
      ['C', 'G', 11],
      ['D', 'E', 2],
      ['D', 'F', 6],
      ['E', 'H', 4],
      ['E', 'G', 9],
      ['F', 'G', 3],
      ['F', 'H', 7],
      ['G', 'H', 2],
    ],
    startNode: 'S',
  },
  {
    id: 'metro-expansion',
    name: 'Metro Expansion',
    nodeOrder: ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'],
    nodes: {
      S: { x: 55, y: 214, color: '#1d1d1b', order: 0 },
      A: { x: 145, y: 79, color: '#2a78d6', order: 1 },
      B: { x: 173, y: 210, color: '#eb6834', order: 2 },
      C: { x: 143, y: 346, color: '#1baf7a', order: 3 },
      D: { x: 306, y: 55, color: '#eda100', order: 4 },
      E: { x: 312, y: 216, color: '#e87ba4', order: 5 },
      F: { x: 301, y: 375, color: '#008300', order: 6 },
      G: { x: 467, y: 68, color: '#4a3aa7', order: 7 },
      H: { x: 456, y: 225, color: '#e34948', order: 8 },
      I: { x: 459, y: 372, color: '#6366f1', order: 9 },
      J: { x: 605, y: 129, color: '#0d9488', order: 10 },
      K: { x: 580, y: 281, color: '#be123c', order: 11 },
    },
    edges: [
      ['S', 'A', 5],
      ['S', 'B', 8],
      ['S', 'C', 3],
      ['A', 'B', 2],
      ['A', 'D', 9],
      ['B', 'C', 4],
      ['B', 'E', 7],
      ['C', 'F', 6],
      ['D', 'E', 3],
      ['D', 'G', 10],
      ['E', 'F', 2],
      ['E', 'H', 8],
      ['F', 'I', 5],
      ['G', 'H', 4],
      ['G', 'J', 6],
      ['H', 'I', 3],
      ['H', 'K', 9],
      ['I', 'K', 4],
      ['J', 'K', 2],
    ],
    startNode: 'S',
  },
  {
    id: 'regional-rail',
    name: 'Regional Rail',
    nodeOrder: ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'],
    nodes: {
      S: { x: 55, y: 216, color: '#1d1d1b', order: 0 },
      A: { x: 139, y: 86, color: '#2a78d6', order: 1 },
      B: { x: 173, y: 217, color: '#eb6834', order: 2 },
      C: { x: 146, y: 353, color: '#1baf7a', order: 3 },
      D: { x: 294, y: 58, color: '#eda100', order: 4 },
      E: { x: 312, y: 215, color: '#e87ba4', order: 5 },
      F: { x: 297, y: 375, color: '#008300', order: 6 },
      G: { x: 449, y: 55, color: '#4a3aa7', order: 7 },
      H: { x: 458, y: 216, color: '#e34948', order: 8 },
      I: { x: 448, y: 375, color: '#6366f1', order: 9 },
      J: { x: 592, y: 66, color: '#0d9488', order: 10 },
      K: { x: 605, y: 215, color: '#be123c', order: 11 },
      L: { x: 591, y: 366, color: '#65a30d', order: 12 },
    },
    edges: [
      ['S', 'A', 4],
      ['S', 'B', 7],
      ['S', 'C', 11],
      ['A', 'B', 3],
      ['A', 'D', 8],
      ['B', 'C', 5],
      ['B', 'E', 6],
      ['C', 'F', 4],
      ['D', 'E', 2],
      ['D', 'G', 9],
      ['E', 'F', 3],
      ['E', 'H', 7],
      ['F', 'I', 5],
      ['G', 'H', 4],
      ['G', 'J', 6],
      ['H', 'I', 3],
      ['H', 'K', 8],
      ['I', 'L', 6],
      ['J', 'K', 2],
      ['K', 'L', 3],
    ],
    startNode: 'S',
  },
];
