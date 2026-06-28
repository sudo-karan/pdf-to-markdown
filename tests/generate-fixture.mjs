// Generate a deterministic test PDF (headings, list, a raster image with a
// "Figure 1" caption, and a vector SVG diagram with a "Figure 2" caption) using
// headless Chromium. Output: tests/fixture.pdf
//
// Requires: playwright-core (devDependency) + a Chromium binary.
// Point at the browser with CHROMIUM_PATH, e.g.:
//   CHROMIUM_PATH=/path/to/chrome node tests/generate-fixture.mjs
import pw from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXE = process.env.CHROMIUM_PATH;
if (!EXE) { console.error('Set CHROMIUM_PATH to a Chromium/Chrome executable.'); process.exit(2); }
const OUT = process.argv[2] || join(__dirname, 'fixture.pdf');

const browser = await pw.chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage();

// A real raster PNG via canvas -> becomes an image XObject in the PDF.
const pngDataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 320, 180);
  x.fillStyle = '#c0392b'; x.fillRect(20, 30, 120, 120);
  x.fillStyle = '#2980b9'; x.fillRect(170, 30, 120, 120);
  x.fillStyle = '#000'; x.font = '20px sans-serif';
  x.fillText('RASTER 12345', 60, 100);
  return c.toDataURL('image/png');
});

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Quarterly Engineering Report</title><style>
  body { font-family: Georgia, serif; font-size: 12pt; margin: 40px; color:#111; }
  h1 { font-size: 26pt; } h2 { font-size: 18pt; } h3 { font-size: 14pt; }
  .cap { font-style: italic; font-size: 10pt; color:#333; }
  ul { margin: 8px 0 16px 24px; }
  table { border-collapse: collapse; margin: 12px 0; font-size: 11pt; }
  th, td { border: 1px solid #333; padding: 5px 16px; text-align: left; }
</style></head><body>
  <h1>Quarterly Engineering Report</h1>
  <p>This document tests <strong>bold text</strong> and <em>italic text</em> extraction,
     along with headings, lists, raster images, and vector diagrams.</p>
  <h2>Key Results</h2>
  <p>The following points summarize the quarter.</p>
  <ul>
    <li>Throughput increased by 42 percent.</li>
    <li>Latency dropped to under 100 milliseconds.</li>
    <li>Three new services shipped to production.</li>
  </ul>
  <h2>Figures</h2>
  <p>A raster chart is shown below.</p>
  <img src="${pngDataUrl}" width="320" height="180" />
  <p class="cap">Figure 1: A red and blue raster test chart with sample label.</p>
  <h3>System Diagram</h3>
  <svg width="360" height="160" xmlns="http://www.w3.org/2000/svg">
    <rect x="10" y="40" width="90" height="50" fill="none" stroke="#222" stroke-width="2"/>
    <rect x="135" y="40" width="90" height="50" fill="none" stroke="#222" stroke-width="2"/>
    <rect x="260" y="40" width="90" height="50" fill="none" stroke="#222" stroke-width="2"/>
    <line x1="100" y1="65" x2="135" y2="65" stroke="#222" stroke-width="2"/>
    <line x1="225" y1="65" x2="260" y2="65" stroke="#222" stroke-width="2"/>
    <text x="30" y="70" font-size="12">Login</text>
    <text x="158" y="70" font-size="12">Auth</text>
    <text x="278" y="70" font-size="12">Home</text>
  </svg>
  <p class="cap">Figure 2: Vector flow diagram of the login sequence.</p>
  <h2>Latency by service</h2>
  <table>
    <tr><th>Service</th><th>Role</th><th>Latency</th></tr>
    <tr><td>auth-api</td><td>Auth</td><td>40 ms</td></tr>
    <tr><td>login-ui</td><td>Login</td><td>55 ms</td></tr>
    <tr><td>home-svc</td><td>Home</td><td>30 ms</td></tr>
  </table>
  <h2>Conclusion</h2>
  <p>All targets were met this quarter.</p>
</body></html>`;

await page.setContent(html, { waitUntil: 'networkidle' });
await page.pdf({ path: OUT, format: 'A4', printBackground: true });
await browser.close();
console.log('wrote', OUT);
