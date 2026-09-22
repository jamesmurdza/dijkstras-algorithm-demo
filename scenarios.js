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
 * instead. Colors reuse the same fixed 8-slot categorical palette in the
 * same order (S is always the neutral ink color; A, B, C... always get
 * the same color regardless of which scenario is active), so a color
 * keeps meaning "this many hops into the alphabet" across scenarios
 * rather than being reassigned per graph.
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
];
