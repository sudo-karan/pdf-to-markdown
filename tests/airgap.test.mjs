// End-to-end test: serve the app locally, convert a fixture PDF in headless
// Chromium under the REAL Content-Security-Policy, and assert both that the
// conversion is correct AND that ZERO off-host network requests are made
// (the air-gap guarantee). Exits non-zero on any failure.
//
// Prereqs: playwright-core (devDependency), python3 (for serve.py), and a
// Chromium binary referenced by CHROMIUM_PATH. Run:
//   CHROMIUM_PATH=/path/to/chrome node tests/airgap.test.mjs
import pw from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 8731);
const BASE = `http://127.0.0.1:${PORT}/`;
const EXE = process.env.CHROMIUM_PATH;
const FIXTURE = join(__dirname, 'fixture.pdf');

if (!EXE) { console.error('Set CHROMIUM_PATH to a Chromium/Chrome executable.'); process.exit(2); }
if (!existsSync(FIXTURE)) { console.error('Missing tests/fixture.pdf — run `node tests/generate-fixture.mjs` first.'); process.exit(2); }

const server = spawn('python3', [join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + 'index.html'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };

try {
  await waitForServer();
  const browser = await pw.chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  const offHost = [], pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('request', r => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) offHost.push(r.url());
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.setInputFiles('#fileInput', FIXTURE);
  await page.click('#convertBtn');

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => {
      const s = document.getElementById('status'), d = document.getElementById('downloadBtn');
      return (s && /failed/i.test(s.textContent)) || (d && !d.disabled);
    });
    if (done) break;
    await new Promise(r => setTimeout(r, 300));
  }

  const md = await page.$eval('#sourcePane', el => el.value);
  const imgCount = await page.$$eval('#previewPane img', els => els.length);
  await browser.close();

  check('air-gap: no off-host requests', offHost.length === 0);
  if (offHost.length) console.log('   off-host:', offHost.join(', '));
  check('no page errors', pageErrors.length === 0);
  check('h1 heading', /^#\s+/m.test(md));
  check('h2 heading', /^##\s+/m.test(md));
  check('bold emphasis', /\*\*bold text\*\*/.test(md));
  check('italic emphasis', /\*italic text\*/.test(md));
  check('bullet list items', /(^|\n)- .*Throughput/.test(md) && /Latency dropped/.test(md));
  check('raster image embedded', /!\[[^\]]*\]\(images\/[^)]+\.(jpg|png)\)/.test(md));
  check('Figure 1 caption attached', /Figure 1/.test(md));
  check('vector diagram (Figure 2) captured', /Figure 2/.test(md));
  check('two images in preview', imgCount === 2);
  check('front matter present', /^---\n[\s\S]*title:/m.test(md));
} catch (e) {
  console.error('ERROR:', e.message); failures++;
} finally {
  stop();
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
