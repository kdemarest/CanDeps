// deps: what in the workspace is out of date, and why. It never builds anything on its own and
// never writes into another project; it writes its own status files and answers questions. Its
// page (serve, /) builds what Ken ticks there and asks for, one at a time, in dependency order,
// by each producer's own build command (never AI: gptviz images are made in Obsidian).
//   node deps/deps.js check          writes deps/status.json and deps/status.md once
//   node deps/deps.js serve [port]   keeps them current (polling), serves them and the page (port 8070)
// Producers it knows (each with its inputs and outputs, read from the projects' own files):
//   gptviz  # Prompt / # Extract blocks in the scan folders (workspace.json): inputs are the
//           block's text and its Images: (Prompt) or Source: (Extract) images, outputs the image
//           in the outputs folder, as gptviz reads them: notes excluded by its _config.json
//           (in the outputs folder) skipped, target names only of letters, digits, spaces, _ - .,
//           headings in code blocks ignored. Mark and Script blocks are listed as not tracked.
//   modl    each modl/obj/<family>.py: its # Modl section's text and Source: lines (a bare name is
//           an image on the search path, "Canopy <path>" a Canopy file), the script and modl.py;
//           outputs its files in modl/obj/ and Canopy's Assets/Modl/<FAMILY>/.
//   assemblage  each docs scene with "assemblage: true": its Origin, Piece and frontmatter lines,
//           its pieces' prefabs, and layout/tools/assemblage.js; outputs Canopy's
//           Assets/Assemblages/<Name>/.
// Staleness from a ledger (cache/ledger.json) of content hashes: the first time deps sees a
// producer it takes its inputs as current; whenever the producer's outputs change, it ran, and
// its inputs are taken as current again; an input whose hash differs since makes it stale, and
// everything downstream of a stale producer is behind.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEV = path.join(__dirname, '..');
const CANOPY = process.env.CANOPY || '/sdcard/Canopy';
const CANOPY_GIT = ['--git-dir=' + path.join(process.env.HOME, 'git-repos', 'Canopy.git')];
const CACHE = path.join(__dirname, 'cache');
const LEDGER = path.join(CACHE, 'ledger.json');
const STATUS_JSON = path.join(__dirname, 'status.json');
const STATUS_MD = path.join(__dirname, 'status.md');

// The workspace's own name resolution (tools/resolve.js), as gptviz and movi use it.
globalThis.unit = (name, deps, factory) => factory();
require(path.join(DEV, 'tools', 'resolve.js'));
const W = globalThis.WorkspaceResolve;

// ---------- files and hashes ----------
// A file is "vault:<path under dev/>" or "canopy:<path under the Canopy repo>".
const sha1 = data => crypto.createHash('sha1').update(data).digest('hex');
const fullPath = key => (key.startsWith('canopy:') ? path.join(CANOPY, key.slice(7)) : path.join(DEV, key.slice(6)));
const statOf = file => {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
};
let ledger = { producers: {}, hashes: {} };
// A file's content hash, recomputed only when its time or size changed; a Canopy file absent
// from the (sparse) working tree is its committed blob.
function hashOf(key, committed) {
  const s = statOf(fullPath(key));
  if (!s) return key.startsWith('canopy:') && committed.has(key.slice(7)) ? 'git:' + committed.get(key.slice(7)) : 'missing';
  const stamp = `${s.mtimeMs}:${s.size}`;
  const known = ledger.hashes[key];
  if (known && known.stamp === stamp) return known.hash;
  const hash = sha1(fs.readFileSync(fullPath(key)));
  ledger.hashes[key] = { stamp, hash };
  return hash;
}
// An output's signature: its time and size (or missing); a change means its producer ran.
const signatureOf = key => {
  const s = statOf(fullPath(key));
  return s ? `${s.mtimeMs}:${s.size}` : 'missing';
};
let committedCache = { head: null, map: new Map() };
// Canopy's committed files (path -> blob), once per HEAD.
function committed() {
  try {
    const head = execFileSync('git', CANOPY_GIT.concat(['rev-parse', 'HEAD'])).toString().trim();
    if (head !== committedCache.head) {
      const map = new Map();
      for (const line of execFileSync('git', CANOPY_GIT.concat(['ls-tree', '-r', 'HEAD']), { maxBuffer: 1 << 30 }).toString().split('\n')) {
        const tab = line.indexOf('\t');
        if (tab > 0) map.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[2]);
      }
      committedCache = { head, map };
    }
  } catch { /* no Canopy git here: working-tree files only */ }
  return committedCache.map;
}

// Every file under a vault folder (recursively or not), as vault paths.
function walk(dir, recurse, out = []) {
  const full = path.join(DEV, dir);
  let entries;
  try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (recurse) walk(rel, true, out);
    } else out.push(rel);
  }
  return out;
}

// ---------- producers ----------
// { id, kind, name, where, inputs: [{ key, text? }], outputs: [key], cost, how, notes }
// An input with text is a section of a note: its hash is the text's.
function workspace() {
  const config = W.parse(fs.readFileSync(path.join(DEV, W.FILE), 'utf8'));
  const files = [...new Set([...config.path, ...config.scan].flatMap(e => walk(e.dir, e.recurse)))];
  return { config, files, index: W.buildIndex(config, files) };
}
const headingOf = line => {
  const m = /^(#+)[ \t]+(.+?)\s*$/.exec(line);
  return m ? { level: m[1].length, text: m[2] } : null;
};
// A heading's section: its lines up to the next heading of the same or a higher level.
function sectionAt(lines, i) {
  const level = headingOf(lines[i]).level;
  let end = i + 1;
  while (end < lines.length && !((h => h && h.level <= level)(headingOf(lines[end])))) end++;
  return lines.slice(i, end).join('\n');
}
// gptviz's exclusions: its _config.json's exclude_files, matching a vault path or a file name,
// * matching anything.
function excluded(ws) {
  let patterns = [];
  try { patterns = JSON.parse(fs.readFileSync(path.join(DEV, W.outputPath(ws.config, '_config.json')), 'utf8')).exclude_files || []; } catch { /* none */ }
  const res = patterns.map(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
  return file => res.some(re => re.test(file) || re.test(path.basename(file)));
}
function gptvizProducers(ws) {
  const out = [], untracked = [];
  const skip = excluded(ws);
  const scanned = ws.files.filter(f => f.endsWith('.md') && W.inScan(ws.config, f) && !f.toLowerCase().startsWith(ws.config.candidates.toLowerCase() + '/') && !skip(f));
  for (const note of scanned) {
    const lines = fs.readFileSync(path.join(DEV, note), 'utf8').replace(/\r\n/g, '\n').split('\n');
    let fenced = false;
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const h = !fenced && headingOf(line);
      const m = h && /^(Prompt|Extract|Mark|Script)(?::[ \t]*|[ \t]+)(.+)$/.exec(h.text);
      if (!m) return;
      const [, op, name] = m;
      if (!/^[A-Za-z0-9_ -]+(?:\.[A-Za-z0-9_ -]+)*$/.test(name)) return; // gptviz rejects it too
      if (op === 'Mark' || op === 'Script') return untracked.push(`${op} ${name} (${note})`);
      const text = sectionAt(lines, i);
      const inputs = [{ key: `text:${note}#${op} ${name}`, text }];
      const names = op === 'Prompt'
        ? [...text.matchAll(/^[ \t]*Images:[ \t]*(.*)$/gim)].flatMap(x => x[1].split(',')).map(s => s.trim()).filter(Boolean)
        : [((/^[ \t]*Source:[ \t]*(.+)$/im.exec(text) || [])[1] || `${path.basename(note, '.md')}.png`).trim()];
      const notes = [];
      for (const n of names) {
        const r = W.resolve(ws.index, n, ['.png', '.jpg', '.jpeg']);
        if (r.error) notes.push(r.error);
        else inputs.push({ key: 'vault:' + r.path });
      }
      const file = /\.[^./]+$/.test(name) ? name : `${name}.png`;
      out.push({ id: `gptviz:${note}#${op} ${name}`, kind: 'gptviz', name: `${op} ${name}`, where: note, inputs, outputs: ['vault:' + W.outputPath(ws.config, file)], cost: 'AI (gptviz)', how: `gptviz: ${op} ${name} in ${note}`, notes });
    });
  }
  return { producers: out, untracked };
}
function modlProducers(ws) {
  const out = [];
  const dir = 'modl/obj';
  for (const script of walk(dir, false).filter(f => f.endsWith('.py') && !/\/(modl|serve)\.py$/.test(f))) {
    const text = fs.readFileSync(path.join(DEV, script), 'utf8');
    const family = (/^FAMILY = "([^"]+)"/m.exec(text) || [])[1];
    const heading = (/^HEADING = "([^"]+)"/m.exec(text) || [])[1];
    const doc = /^DOC = os\.path\.join\(modl\.DOCS,((?:\s*"[^"]+",?)+)\)/m.exec(text);
    if (!family || !heading || !doc) continue;
    const docPath = 'docs/' + [...doc[1].matchAll(/"([^"]+)"/g)].map(x => x[1]).join('/');
    const lines = fs.existsSync(path.join(DEV, docPath)) ? fs.readFileSync(path.join(DEV, docPath), 'utf8').replace(/\r\n/g, '\n').split('\n') : [];
    const at = lines.findIndex(l => l.trim() === `# ${heading}`);
    const notes = [];
    const inputs = [{ key: `vault:${script}` }, { key: `vault:${dir}/modl.py` }];
    if (at < 0) notes.push(`no '# ${heading}' in ${docPath}`);
    else {
      // modl's sections end at the next top-level heading (its ## subsections belong to it)
      let end = at + 1;
      while (end < lines.length && !/^# /.test(lines[end])) end++;
      const section = lines.slice(at, end).join('\n');
      inputs.push({ key: `text:${docPath}#${heading}`, text: section });
      for (const m of section.matchAll(/^Source:(.*)$/gm)) {
        const s = m[1].trim();
        if (s.startsWith('Canopy ')) inputs.push({ key: 'canopy:' + s.slice(7).trim() });
        else {
          const r = W.resolve(ws.index, s, ['.png']);
          if (r.error) notes.push(r.error);
          else inputs.push({ key: 'vault:' + r.path });
        }
      }
    }
    const outputs = [...walk(dir, false).filter(f => path.basename(f).startsWith(family) && !f.endsWith('.py')).map(f => 'vault:' + f),
      ...canopyFiles(`Assets/Modl/${family}`).map(f => 'canopy:' + f)];
    out.push({ id: `modl:${family}`, kind: 'modl', name: heading.replace(/^Modl /, ''), where: docPath, inputs, outputs, cost: 'modl script, seconds', how: `cd modl && python3 obj/${path.basename(script)} --write (layout also rebuilds it when its doc or script changes)`, build: { cmd: ['python3', `obj/${path.basename(script)}`, '--write'], cwd: 'modl' }, notes });
  }
  return out;
}
const canopyFiles = dir => {
  try {
    return fs.readdirSync(path.join(CANOPY, dir)).filter(n => statOf(path.join(CANOPY, dir, n))).map(n => `${dir}/${n}`);
  } catch {
    return [];
  }
};
let prefabCache = { at: 0, map: new Map() };
// Canopy's prefabs by name (the working tree holds every prefab); walked at most once a minute.
function prefabsByName() {
  if (Date.now() - prefabCache.at < 60000) return prefabCache.map;
  const map = new Map();
  (function walkCanopy(dir) {
    let entries;
    try { entries = fs.readdirSync(path.join(CANOPY, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walkCanopy(rel);
      else if (e.name.endsWith('.prefab') && !map.has(e.name.slice(0, -7))) map.set(e.name.slice(0, -7), rel);
    }
  })('Assets');
  prefabCache = { at: Date.now(), map };
  return map;
}
const pascal = name => name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
function assemblageProducers() {
  const out = [];
  const dir = 'docs/scenes';
  for (const scene of walk(dir, false).filter(f => f.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(DEV, scene), 'utf8').replace(/\r\n/g, '\n');
    if (!/^---\n[\s\S]*?^assemblage:\s*true\s*$[\s\S]*?^---$/m.test(text)) continue;
    const name = path.basename(scene, '.md');
    // only what the prefab is built from: the frontmatter, Origin and Piece lines
    const lines = text.split('\n').filter(l => /^\s*-\s*(Origin|Piece):/.test(l) || /^assemblage:/.test(l)).join('\n');
    const inputs = [{ key: `text:${scene}#assemblage`, text: lines }, { key: 'vault:layout/tools/assemblage.js' }];
    const notes = [];
    const prefabs = prefabsByName();
    for (const piece of new Set([...lines.matchAll(/Piece:\s*([^|]+?)\s*\|/g)].map(m => m[1]))) {
      if (prefabs.has(piece)) inputs.push({ key: 'canopy:' + prefabs.get(piece) });
      else notes.push(`no prefab named ${piece}`);
    }
    const target = `Assets/Assemblages/${pascal(name)}`;
    out.push({ id: `assemblage:${name}`, kind: 'assemblage', name, where: scene, inputs, outputs: canopyFiles(target).map(f => 'canopy:' + f), cost: 'layout, about a second', how: `layout rebuilds it on Save and when its pieces change; or: cd layout && node tools/assemblage.js "${name}" --write`, build: { cmd: ['node', 'tools/assemblage.js', name, '--write'], cwd: 'layout' }, notes });
  }
  return out;
}
// A prefab built by modl is the output of its family; its own nested models are found through
// the family's outputs, so an assemblage depends on the family via the prefab.

// ---------- status ----------
function check() {
  try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { /* first run */ }
  ledger.producers = ledger.producers || {};
  ledger.hashes = ledger.hashes || {};
  const ws = workspace();
  const g = gptvizProducers(ws);
  const producers = [...g.producers, ...modlProducers(ws), ...assemblageProducers()];
  const git = committed();
  const byOutput = new Map();
  for (const p of producers) for (const o of p.outputs) byOutput.set(o, p);
  for (const p of producers) {
    const hashes = Object.fromEntries(p.inputs.map(i => [i.key, i.text !== undefined ? sha1(i.text) : hashOf(i.key, git)]));
    const signature = sha1(p.outputs.map(o => `${o}=${signatureOf(o)}`).sort().join('\n'));
    const known = ledger.producers[p.id];
    p.missing = p.outputs.length === 0 || p.outputs.some(o => signatureOf(o) === 'missing');
    if (!known || known.signature !== signature) {
      // first seen, or its outputs changed (it ran): its inputs are current as of now
      ledger.producers[p.id] = { signature, inputs: hashes, at: new Date().toISOString() };
      p.changed = [];
    } else p.changed = Object.keys(hashes).filter(k => known.inputs[k] !== hashes[k]).concat(Object.keys(known.inputs).filter(k => !(k in hashes)).map(k => `${k} (no longer an input)`));
    p.status = p.missing ? (p.kind === 'gptviz' ? 'unmade' : 'missing') : p.changed.length ? 'stale' : 'current';
    p.builtAt = ledger.producers[p.id].at;
  }
  // downstream: a producer whose input is a stale (or missing) producer's output is behind
  const usersOf = new Map();
  for (const p of producers) for (const i of p.inputs) if (byOutput.has(i.key)) (usersOf.get(byOutput.get(i.key)) || usersOf.set(byOutput.get(i.key), new Set()).get(byOutput.get(i.key))).add(p);
  const queue = producers.filter(p => p.status !== 'current');
  for (const p of producers) p.behind = [];
  while (queue.length) {
    const p = queue.shift();
    for (const u of usersOf.get(p) || []) {
      if (u.behind.includes(p.id)) continue;
      u.behind.push(p.id);
      if (u.status === 'current') {
        u.status = 'behind';
        queue.push(u);
      }
    }
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger));
  builds = new Map(producers.filter(p => p.build).map(p => [p.id, p.build]));
  const status = {
    generated: new Date().toISOString(),
    counts: Object.fromEntries(['stale', 'missing', 'behind', 'unmade', 'current'].map(s => [s, producers.filter(p => p.status === s).length])),
    producers: producers.map(p => ({
      id: p.id, kind: p.kind, name: p.name, where: p.where, status: p.status,
      changed: p.changed, behind: p.behind, cost: p.cost, how: p.how, builtAt: p.builtAt, notes: p.notes,
      buildable: Boolean(p.build), upstream: p.inputs.filter(i => byOutput.has(i.key)).map(i => byOutput.get(i.key).id).filter((id, k, a) => a.indexOf(id) === k),
      inputs: p.inputs.map(i => i.key), outputs: p.outputs
    })),
    untracked: g.untracked
  };
  return status;
}
const label = key => key.replace(/^vault:/, '').replace(/^canopy:/, 'Canopy ').replace(/^text:(.*)#(.*)$/, '$2 text in $1');
function markdown(status) {
  const c = status.counts;
  const out = [`# Dependencies`, '', `Generated by deps (\`deps/deps.js\`) at ${status.generated}: ${c.stale} stale, ${c.missing} missing, ${c.behind} behind, ${c.unmade} not made, ${c.current} current. Nothing here is rebuilt automatically by deps; each line says how.`, ''];
  const by = s => status.producers.filter(p => p.status === s);
  const section = (title, list, line) => {
    if (!list.length) return;
    out.push(`## ${title}`, '');
    for (const p of list) out.push(line(p));
    out.push('');
  };
  const head = p => `- **${p.name}** (${p.kind}, ${p.where}; ${p.cost})`;
  section('Stale', by('stale'), p => `${head(p)}: ${p.changed.map(label).join(', ')} changed. ${p.how}.`);
  section('Missing', by('missing'), p => `${head(p)}: an output is missing. ${p.how}.`);
  section('Behind', by('behind'), p => `${head(p)}: after ${p.behind.map(id => (status.producers.find(q => q.id === id) || { name: id }).name).join(', ')}.`);
  const notes = status.producers.filter(p => p.notes && p.notes.length);
  section('Problems', notes, p => `- **${p.name}** (${p.where}): ${p.notes.join('; ')}`);
  if (by('unmade').length) out.push('## Not made', '', 'Images whose block exists but which were never generated (or were removed): ' + by('unmade').map(p => `${p.name} (${p.where})`).join(', ') + '.', '');
  section('Current', by('current'), p => `- ${p.name} (${p.kind})`);
  if (status.untracked.length) out.push('## Not tracked', '', `Mark and Script blocks (their outputs are not files deps can follow): ${status.untracked.length}.`, '');
  return out.join('\n');
}
function write(status) {
  const json = JSON.stringify(status, null, 1);
  const md = markdown(status);
  const changed = (file, text) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/at \S+Z/, '') !== text.replace(/at \S+Z/, '');
  // rewritten only when something besides the time changed, so watchers aren't woken for nothing
  if (changed(STATUS_MD, md) || !fs.existsSync(STATUS_JSON)) {
    fs.writeFileSync(STATUS_JSON, json);
    fs.writeFileSync(STATUS_MD, md);
    return true;
  }
  return false;
}

// ---------- building (only when asked, from the page) ----------
let builds = new Map(); // producer id -> { cmd, cwd }, from the last check
// The asked-for producers in dependency order: each after any asked-for producer it reads.
function buildOrder(ids, status) {
  const want = new Set(ids.filter(id => builds.has(id)));
  const upstream = new Map(status.producers.map(p => [p.id, p.upstream || []]));
  const order = [], seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const u of upstream.get(id) || []) if (want.has(u)) visit(u);
    order.push(id);
  };
  [...want].forEach(visit);
  return order;
}

// ---------- serve ----------
// Polls every few seconds; rewrites the status files and tells /events listeners when they
// change. GET /status.json, /status.md, /users?file=<name or path> (what reads that file),
// /node?id=<producer id>, /events (server-sent "status" events).
function serve(port) {
  let status = check();
  write(status);
  const listeners = new Set();
  const tell = (event, data) => {
    for (const res of listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // One build at a time; the page sees each one's output as it comes.
  const run = { queue: [], running: null, log: [] };
  const say = line => {
    run.log.push(line);
    if (run.log.length > 400) run.log.splice(0, run.log.length - 400);
    tell('build', { line, running: run.running, queue: run.queue });
  };
  const next = () => {
    if (run.running || !run.queue.length) return;
    const id = run.queue.shift();
    const b = builds.get(id);
    if (!b) return next();
    run.running = id;
    say(`▶ ${id}: ${b.cmd.join(' ')} (in ${b.cwd}/)`);
    const child = require('child_process').spawn(b.cmd[0], b.cmd.slice(1), { cwd: path.join(DEV, b.cwd) });
    const lines = chunk => String(chunk).split('\n').filter(Boolean).forEach(l => say('  ' + l));
    child.stdout.on('data', lines);
    child.stderr.on('data', lines);
    child.on('error', error => say(`  could not start: ${error.message}`));
    child.on('close', code => {
      say(code === 0 ? `✔ ${id}` : `✘ ${id} (exit ${code})`);
      run.running = null;
      try {
        status = check();
        write(status);
        tell('status', status.counts);
      } catch (error) {
        say(`deps: ${error.message}`);
      }
      next();
    });
  };
  setInterval(() => {
    try {
      const next = check();
      const changed = write(next);
      status = next;
      if (changed) for (const res of listeners) res.write(`event: status\ndata: ${JSON.stringify(status.counts)}\n\n`);
    } catch (error) {
      console.error(`deps: ${error.message}`);
    }
  }, 3000);
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    };
    if (url.pathname === '/' || url.pathname === '/index.html') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'page.html')));
    if (url.pathname === '/build' && req.method === 'GET') return send(200, 'application/json', JSON.stringify(run));
    if (url.pathname === '/build' && req.method === 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        let ids = [];
        try { ids = JSON.parse(body || '{}').ids || []; } catch { /* none */ }
        const order = buildOrder(ids.map(String), status).filter(id => id !== run.running && !run.queue.includes(id));
        run.queue.push(...order);
        say(`queued: ${order.join(', ') || 'nothing buildable'}`);
        next();
        send(200, 'application/json', JSON.stringify({ queued: order }));
      });
      return;
    }
    if (url.pathname === '/status.json') return send(200, 'application/json', JSON.stringify(status));
    if (url.pathname === '/status.md') return send(200, 'text/markdown; charset=utf-8', markdown(status));
    if (url.pathname === '/users') {
      const f = String(url.searchParams.get('file') || '').toLowerCase();
      const hit = k => k.toLowerCase() === f || k.toLowerCase().endsWith('/' + f) || k.toLowerCase().endsWith(':' + f);
      return send(200, 'application/json', JSON.stringify(status.producers.filter(p => p.inputs.some(hit)).map(p => ({ id: p.id, name: p.name, status: p.status }))));
    }
    if (url.pathname === '/node') return send(200, 'application/json', JSON.stringify(status.producers.find(p => p.id === url.searchParams.get('id')) || null));
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.write(`retry: 3000\nevent: status\ndata: ${JSON.stringify(status.counts)}\n\n`);
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    send(404, 'text/plain', 'deps: / (the page), /status.json, /status.md, /users?file=, /node?id=, /events, /build');
  }).listen(port, '127.0.0.1', () => console.log(`deps: http://localhost:${port}/`));
}

if (require.main === module) {
  const [mode, port] = process.argv.slice(2);
  if (mode === 'serve') serve(+port || 8070);
  else if (mode === 'check') {
    const status = check();
    write(status);
    const c = status.counts;
    console.log(`deps: ${c.stale} stale, ${c.missing} missing, ${c.behind} behind, ${c.unmade} not made, ${c.current} current; ${path.relative(DEV, STATUS_MD)}`);
    for (const p of status.producers.filter(q => q.status !== 'current' && q.status !== 'unmade')) console.log(`  ${p.status}: ${p.name} (${p.kind})${p.changed.length ? ': ' + p.changed.map(label).join(', ') : ''}`);
  } else {
    console.log('usage: node deps/deps.js check | serve [port]');
    process.exit(2);
  }
}

module.exports = { check, markdown };
