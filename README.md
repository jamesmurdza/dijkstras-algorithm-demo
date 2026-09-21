# Dijkstra's Algorithm — Interactive Subway-Map Visualization

A self-contained, dependency-free web demo (plain HTML/CSS/JS) that runs
Dijkstra's shortest-path algorithm from node `S` step by step, and draws each
destination's current best-known route as its own colored "subway line" on a
fixed graph layout.

## Run it

No build step or server-side code is required — it's static files. Any static
file server works, e.g.:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/index.html`.

## Files

- `dijkstra.js` — graph data (fixed node positions/colors, weighted edges) and
  the real Dijkstra implementation. Produces an ordered list of "frames" — one
  for setup, one per node visit (selecting the node AND relaxing all of its
  outgoing edges at once), and one for completion — that fully drive the UI.
  Has no DOM dependency, so it also runs under plain Node for testing.
- `routing.js` — turns a frame's distances/predecessors into SVG path data for
  each destination's colored route, offsetting shared graph edges into
  parallel, evenly-spaced lanes so overlapping routes stay visually distinct
  (see the comments in that file for the algorithm).
- `app.js` — builds the SVG graph once and renders every step (graph, step
  description, stats table, slider, buttons) from a single `renderStep(index)`
  function, so Back / Next / Reset / the slider can never drift out of sync.
- `index.html`, `styles.css` — markup and the subway-map visual styling
  (responsive: two columns on desktop, stacked on mobile).
- `test/run-tests.js` — automated, dependency-free correctness checks (final
  distances, predecessor-consistency, path reconstruction, and the required
  "shortcut discovery" milestones). Run with:

  ```
  node test/run-tests.js
  ```

## Expected final shortest distances from S

`S=0, B=2, A=3, C=5, F=7, H=10, D=12, G=14, E=15`
