# deps

What in the dev workspace is out of date, and why. deps never builds anything on its own and never runs AI: it answers questions and keeps a status file current, and each stale item says how to rebuild it. Its page (http://localhost:8070/ while it serves) lists what is stale, missing or behind with checkboxes (those ticked at first), and builds what you tick when you ask, one at a time in dependency order (an assemblage after the models it holds), showing each build's output as it runs; the status refreshes after each. gptviz images are listed but made in Obsidian.

    node deps/deps.js check          writes deps/status.md and deps/status.json once
    node deps/deps.js serve [port]   keeps them current (polling every 3 s) and serves them
    runDeps [stop|log]               serve in the background (port 8070)

`deps/status.md` is in the vault, so Obsidian shows it. The server answers `/` (the page), `/build` (GET: the queue and log; POST `{ids}`: build those), `/status.json`, `/status.md`, `/users?file=<name or path>` (what reads a file), `/node?id=<producer id>`, and `/events` (server-sent `status` events when the status changes).

## Producers

Each is read from the projects' own files:

- **gptviz**: `# Prompt <name>` and `# Extract <name>` blocks (any heading level, `:` optional) in the scan folders of `workspace.json`, as gptviz reads them: notes its `_config.json` (in the outputs folder) excludes are skipped, target names are letters, digits, spaces, `_`, `-`, `.`, headings in code blocks are ignored. Inputs: the block's text, and its `Images:` (Prompt) or `Source:` (Extract; default the note's own image) images, found on the search path. Output: `<name>.png` in the outputs folder. Mark and Script blocks are counted as not tracked.
- **modl**: each `modl/obj/<family>.py` with `FAMILY`, `HEADING` and `DOC`. Inputs: its `# Modl` section's text and `Source:` lines (a bare name is an image on the search path, `Canopy <path>` a Canopy file, read from git when the sparse checkout lacks it), the script and `modl.py`. Outputs: its files in `modl/obj/` and Canopy's `Assets/Modl/<FAMILY>/`.
- **assemblage**: each `docs/scenes/*.md` with `assemblage: true`. Inputs: its frontmatter, Origin and Piece lines, its pieces' prefabs in Canopy, and `layout/tools/assemblage.js`. Outputs: Canopy's `Assets/Assemblages/<Name>/`.

## Staleness

deps keeps a ledger of content hashes (`cache/ledger.json`). The first time it sees a producer, it takes its inputs as current. Whenever the producer's outputs change, it ran, and its inputs are taken as current again. An input whose hash differs since makes the producer **stale**; everything downstream of a stale or missing producer is **behind**. A modl or assemblage output gone is **missing**; a gptviz image never generated is **not made** (listed apart, since it is often deliberate). Hashes are recomputed only when a file's time or size changes.

Limits: an input changing while its producer runs can be taken as current; the next run fixes it. gptviz's `# Traits` and prompt includes are not yet followed.
