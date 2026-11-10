// `npm run dev`: the development build, rebuilt on every save (scripts/build.mjs --watch), and reloaded in Chrome by
// itself. Every change to the built scripts or to extension/*.html, *.css or manifest.json gives a new build id, served
// at http://127.0.0.1:4179/dev-reload with what the change needs:
//   - "extension": the background, a content or in-page script, or the manifest changed. The extension reloads
//     (chrome.runtime.reload) and opens again the pages of its own that were open.
//   - "pages": only the settings page, the popup, the setup window or their HTML/CSS changed. Those pages reload.
// The development build asks for it (background/dev-reload.ts); a release has none of it (harness/bundle.py checks).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = 4179;
const EXT = 'extension';
const DIST = path.join(EXT, 'dist');
/** The built scripts of the extension's own pages: a change to these reloads the pages, not the extension. */
const PAGE_SCRIPTS = new Set(['options.js', 'popup.js', 'setup.js']);

// The Pro service as for any development build (ONLYREAD_SERVICE_URL, scripts/build.mjs): unset, the local mock, whose
// sign-in falls back to the real service when the mock is not running; set, that service, which the browser moves to.
const build = spawn(process.execPath, ['scripts/build.mjs', '--watch'], { stdio: 'inherit' });

let stamp = { id: String(Date.now()), kind: 'pages' };
const hashes = new Map();

const hash = (file) => { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; } };
const files = () => [
  ...(fs.existsSync(DIST) ? fs.readdirSync(DIST).filter((f) => f.endsWith('.js')).map((f) => path.join(DIST, f)) : []),
  ...fs.readdirSync(EXT).filter((f) => /\.(html|css)$/.test(f) || f === 'manifest.json').map((f) => path.join(EXT, f)),
];

/** Records what changed since the last look; `quiet` only takes the first picture. */
function scan(quiet = false) {
  const changed = [];
  for (const f of files()) {
    const h = hash(f);
    if (hashes.get(f) !== h) { hashes.set(f, h); changed.push(f); }
  }
  if (quiet || !changed.length) return;
  const whole = changed.some((f) => f.endsWith('manifest.json') || (f.startsWith(DIST) && !PAGE_SCRIPTS.has(path.basename(f))));
  stamp = { id: String(Date.now()), kind: whole ? 'extension' : 'pages' };
  console.log(`[dev] ${changed.map((f) => path.relative(EXT, f)).join(', ')} → reloading ${whole ? 'the extension' : 'its pages'}`);
}

let timer;
const soon = () => { clearTimeout(timer); timer = setTimeout(() => scan(), 250); };
setTimeout(() => {
  scan(true);
  fs.watch(EXT, soon);
  fs.watch(DIST, soon);
}, 1500); // after the first build

const server = http.createServer((req, res) => {
  if (req.url !== '/dev-reload') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(stamp));
});
// Another `npm run dev` already holds the port: say so and stop, with no watcher left behind.
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`[dev] Port ${PORT} is in use: another \`npm run dev\` is already running. Stop it (Ctrl+C there, or \`pkill -f scripts/dev.mjs\`) and run this again.`);
  build.kill();
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`[dev] reload signal on http://127.0.0.1:${PORT}/dev-reload. Load ${path.resolve(EXT)} unpacked.`));

let stopping = false;
const stop = () => { stopping = true; build.kill(); server.close(); process.exit(0); };
// The watch build died (a refused setting such as a bad ONLYREAD_SERVICE_URL, or a crash): nothing would rebuild
// any more, so stop too rather than serve a stale build.
build.on('exit', (code, signal) => {
  if (stopping) return;
  console.error(`[dev] The build stopped (${signal ?? `exit code ${code}`}); see its output above. Stopping.`);
  server.close();
  process.exit(code || 1);
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
