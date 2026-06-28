// app.js — UI glue for the offline PDF -> Markdown converter.
import { convertPdf } from './converter.js';
import { getOcr, terminateOcr } from './ocr.js';
import { renderMarkdown } from './preview.js';

const $ = (id) => document.getElementById(id);

// ---- element refs -----------------------------------------------------------
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const convertBtn = $('convertBtn');
const downloadBtn = $('downloadBtn');
const copyBtn = $('copyBtn');
const progress = $('progress');
const progressBar = $('progressBar');
const progressText = $('progressText');
const statusEl = $('status');
const previewPane = $('previewPane');
const sourcePane = $('sourcePane');
const docMeta = $('docMeta');
const tabPreview = $('tabPreview');
const tabSource = $('tabSource');

// ---- state ------------------------------------------------------------------
let currentFile = null;
let baseMarkdown = '';        // markdown with relative images/ paths
let inlineMarkdown = null;    // cached markdown with base64 data URIs
let images = [];              // [{name, blob}]
let imageUrls = new Map();    // name -> blob: URL (for preview)
let busy = false;

// =============================================================================
// File selection
// =============================================================================
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

['dragenter', 'dragover'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
});

function setFile(file) {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    return setStatus('Please choose a PDF file.', 'error');
  }
  currentFile = file;
  dropZone.classList.add('has-file');
  dropZone.querySelector('.dz-title').textContent = file.name;
  dropZone.querySelector('.dz-sub').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ready to convert`;
  convertBtn.disabled = false;
  setStatus('');
}

// =============================================================================
// Options
// =============================================================================
function gatherOpts() {
  return {
    imageMode: $('optImageMode').value,
    diagrams: $('optDiagrams').checked,
    captions: $('optCaptions').checked,
    altText: $('optAltText').checked,
    ocr: $('optOcr').checked,
    headings: $('optHeadings').checked,
    lists: $('optLists').checked,
    tables: $('optTables').checked,
    emphasis: $('optEmphasis').checked,
    frontMatter: $('optFrontMatter').checked,
    pageRules: $('optPageRules').checked,
    outputMode: $('optOutput').value,
    sourceName: currentFile ? currentFile.name : '',
  };
}

// =============================================================================
// Convert
// =============================================================================
convertBtn.addEventListener('click', convert);

async function convert() {
  if (!currentFile || busy) return;
  busy = true;
  setButtons(true);
  resetOutput();
  showProgress(true);
  setStatus('');

  const opts = gatherOpts();
  try {
    const buf = await currentFile.arrayBuffer();

    const hooks = { onProgress: onProgress };
    if (opts.ocr) {
      setProgress(0.02, 'Preparing offline OCR…');
      const recognize = await getOcr((p, msg) => onProgress(undefined, `OCR model: ${msg} ${Math.round((p || 0) * 100)}%`));
      hooks.ocr = recognize;
    }

    const result = await convertPdf(buf, opts, hooks);
    baseMarkdown = result.markdown;
    images = result.images;
    inlineMarkdown = null;

    // preview image URLs
    revokeImageUrls();
    imageUrls = new Map();
    for (const img of images) imageUrls.set(img.name, URL.createObjectURL(img.blob));

    renderOutputs(opts);

    const imgCount = images.length;
    docMeta.textContent = `${(result.meta.title || currentFile.name)} · ${imgCount} image${imgCount === 1 ? '' : 's'}`;
    let msg = `Converted ✓  ${imgCount} image${imgCount === 1 ? '' : 's'} extracted.`;
    if (result.warnings.length) msg += `  (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})`;
    setStatus(msg, 'ok');
    if (result.warnings.length) console.warn('Conversion warnings:\n' + result.warnings.join('\n'));

    downloadBtn.disabled = false;
    copyBtn.disabled = false;
  } catch (err) {
    console.error(err);
    let hint = err.message || String(err);
    if (location.protocol === 'file:') hint += '  — you are on file://; run the local server (see banner).';
    setStatus('Conversion failed: ' + hint, 'error');
  } finally {
    busy = false;
    setButtons(false);
    showProgress(false);
  }
}

function onProgress(frac, msg) {
  if (typeof frac === 'number') setProgress(frac, msg);
  else if (msg) progressText.textContent = msg;
}

// =============================================================================
// Output rendering (preview + source) and output-mode switching
// =============================================================================
$('optOutput').addEventListener('change', () => { if (baseMarkdown) renderOutputs(gatherOpts()); });

// Preview always uses the in-memory blob URLs; the source pane reflects the
// chosen output mode (inline base64 is built on demand so it isn't shown stale).
async function renderOutputs(opts) {
  previewPane.innerHTML = renderMarkdown(baseMarkdown, imageUrls);
  sourcePane.value = (opts.outputMode === 'inline' && images.length)
    ? await ensureInlineMarkdown()
    : baseMarkdown;
}

// Build inline (base64) markdown lazily — needed for source view / download / copy.
// Single pass over the document with a name→dataURL map (avoids O(images·len)
// rebuilds and substring collisions between names like img-1 / img-11).
async function ensureInlineMarkdown() {
  if (inlineMarkdown != null) return inlineMarkdown;
  const entries = await Promise.all(images.map(async (img) => [img.name, await blobToDataUrl(img.blob)]));
  const map = new Map(entries);
  inlineMarkdown = baseMarkdown.replace(/\]\(([^)\s]+)\)/g, (m, name) => map.has(name) ? `](${map.get(name)})` : m);
  return inlineMarkdown;
}

// =============================================================================
// Tabs
// =============================================================================
tabPreview.addEventListener('click', () => switchTab('preview'));
tabSource.addEventListener('click', async () => {
  if (gatherOpts().outputMode === 'inline') { await ensureInlineMarkdown(); sourcePane.value = inlineMarkdown; }
  switchTab('source');
});
function switchTab(which, focus) {
  const p = which === 'preview';
  tabPreview.classList.toggle('active', p);
  tabSource.classList.toggle('active', !p);
  tabPreview.setAttribute('aria-selected', String(p));
  tabSource.setAttribute('aria-selected', String(!p));
  tabPreview.tabIndex = p ? 0 : -1;        // roving tabindex
  tabSource.tabIndex = p ? -1 : 0;
  previewPane.classList.toggle('hidden', !p);
  sourcePane.classList.toggle('hidden', p);
  if (focus) (p ? tabPreview : tabSource).focus();
}

// Arrow-key navigation across the tablist (WAI-ARIA tabs pattern).
[tabPreview, tabSource].forEach((tab) => {
  tab.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      switchTab(tab === tabPreview ? 'source' : 'preview', true);
    }
  });
});

// =============================================================================
// Download / Copy
// =============================================================================
downloadBtn.addEventListener('click', async () => {
  const opts = gatherOpts();
  const base = (currentFile.name || 'document').replace(/\.pdf$/i, '') || 'document';
  try {
    if (opts.outputMode === 'inline' || images.length === 0) {
      const md = opts.outputMode === 'inline' ? await ensureInlineMarkdown() : baseMarkdown;
      downloadBlob(new Blob([md], { type: 'text/markdown' }), base + '.md');
    } else {
      setStatus('Building ZIP…');
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      zip.file(base + '.md', baseMarkdown);
      for (const img of images) zip.file(img.name, img.blob); // name already starts with images/
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, base + '.zip');
      setStatus('ZIP downloaded ✓', 'ok');
    }
  } catch (e) {
    console.error(e);
    setStatus('Download failed: ' + e.message, 'error');
  }
});

copyBtn.addEventListener('click', async () => {
  const opts = gatherOpts();
  const md = opts.outputMode === 'inline' ? await ensureInlineMarkdown() : baseMarkdown;
  try {
    await navigator.clipboard.writeText(md);
    setStatus('Markdown copied to clipboard ✓', 'ok');
  } catch {
    // Clipboard API unavailable (e.g. insecure context): fall back to a temporary
    // selection, then restore the pane's prior visibility so the UI isn't altered.
    const wasHidden = sourcePane.classList.contains('hidden');
    sourcePane.classList.remove('hidden');
    const prev = sourcePane.value;
    sourcePane.value = md; sourcePane.select();
    const ok = document.execCommand && document.execCommand('copy');
    if (!ok) sourcePane.value = prev;
    if (wasHidden) sourcePane.classList.add('hidden');
    setStatus(ok ? 'Copied (fallback).' : 'Copy not supported here — use the Markdown source tab.', ok ? 'ok' : 'error');
  }
});

// =============================================================================
// Helpers
// =============================================================================
function setButtons(disabled) {
  convertBtn.disabled = disabled || !currentFile;
  if (disabled) { downloadBtn.disabled = true; copyBtn.disabled = true; }
}
function resetOutput() {
  revokeImageUrls();                 // release previous conversion's preview blob URLs
  baseMarkdown = ''; inlineMarkdown = null; images = [];
  previewPane.innerHTML = '<div class="empty-state"><p class="muted">Converting…</p></div>';
  sourcePane.value = '';
  docMeta.textContent = '';
}
function showProgress(on) { progress.classList.toggle('hidden', !on); if (on) setProgress(0, 'Starting…'); }
function setProgress(frac, msg) {
  const f = Number(frac);
  if (Number.isFinite(f)) progressBar.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
  if (msg) progressText.textContent = msg;
}
function setStatus(msg, kind) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}
function revokeImageUrls() { for (const url of imageUrls.values()) URL.revokeObjectURL(url); imageUrls.clear(); }

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// JSZip is UMD; lazy-load it as a classic script only when a ZIP is requested.
let _jszip = null;
function loadJSZip() {
  if (_jszip) return _jszip;
  _jszip = new Promise((resolve, reject) => {
    if (window.JSZip) return resolve(window.JSZip);
    const s = document.createElement('script');
    s.src = new URL('vendor/jszip/jszip.min.js', document.baseURI).href;
    s.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip failed to load'));
    // Note: on failure we clear the cached promise below so a later attempt can retry.
    s.onerror = () => reject(new Error('Could not load vendored jszip.min.js'));
    document.head.appendChild(s);
  });
  _jszip.catch(() => { _jszip = null; });   // don't cache a rejection — allow retry
  return _jszip;
}

// =============================================================================
// Network/air-gap indicator + file:// guard
// =============================================================================
(function initNetBadge() {
  const badge = $('netBadge'), text = $('netText');
  if (location.protocol === 'file:') {
    badge.classList.add('warn');
    text.textContent = 'file:// — run local server';
    $('offlineBanner').classList.remove('hidden');
  } else {
    badge.classList.add('ok');
    text.textContent = 'Local-only · no network used';
  }
  $('dismissBanner').addEventListener('click', () => $('offlineBanner').classList.add('hidden'));
})();

// Tidy up the OCR worker when leaving the page.
window.addEventListener('beforeunload', () => { terminateOcr(); revokeImageUrls(); });
