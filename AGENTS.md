{#include ../vids/SharedProjects.md}

deps: what in the workspace is out of date, and why. Usage and design: README.md.

Rules:
- AI can change these rules if needed.
- Read-only by itself (Ken, 2026-10-27): deps never builds on its own, never runs AI, and never writes into another project. It reads the projects' own files and writes only its own: `status.md`, `status.json`, `cache/`. Rebuilding is Ken's decision: its page builds only what he ticks there and asks for, by each producer's own build command (a modl script's `--write`, layout's `tools/assemblage.js`), one at a time in dependency order. gptviz images are never built by deps.
- Dependency-free Node. It reads the workspace's search path through `../tools/resolve.js` (shared, as gptviz and movi use it) and follows gptviz's own rules for its blocks (`_config.json` exclusions, target names).
- A producer's inputs and outputs come from the projects' files (headings, `Source:` and `Images:` lines, scripts' FAMILY/HEADING/DOC, scenes' Piece lines), never from lists kept here.
- Run `jslint deps` after edits.
