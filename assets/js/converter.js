// converter.js — offline PDF -> Markdown engine, built on a locally-vendored pdf.js.
// No network access of any kind: worker, cmaps and standard fonts are all loaded
// from ./vendor. The module exposes a single async function, convertPdf().

import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.js';

// Resolve vendored asset URLs relative to the page (works under any path the
// app is served from). document.baseURI is the URL of index.html.
const v = (p) => new URL('vendor/' + p, document.baseURI).href;

pdfjsLib.GlobalWorkerOptions.workerSrc = v('pdfjs/pdf.worker.min.js');

const { OPS, Util } = pdfjsLib;

// Operator groups we care about ------------------------------------------------
const PAINT_OPS = new Set([
  OPS.fill, OPS.eoFill, OPS.stroke, OPS.fillStroke, OPS.eoFillStroke,
  OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.closeStroke,
]);
const FIGURE_RE = /^(fig(?:ure|\.)?|table|tab\.?|diagram|chart|scheme|exhibit|plate|listing|algorithm|eq(?:uation)?\.?)\s*\.?\s*([0-9]+|[ivxlcdm]+|[A-Z])\b/i;

// constructPath sub-operators and how many flat coordinates each consumes.
const PATH = {
  moveTo: OPS.moveTo, lineTo: OPS.lineTo, curveTo: OPS.curveTo,
  curveTo2: OPS.curveTo2, curveTo3: OPS.curveTo3, closePath: OPS.closePath,
  rectangle: OPS.rectangle,
};

// Compute the device-space bounding box of one constructPath, honouring each
// sub-op's coordinate semantics (notably `rectangle` = [x, y, w, h], and curves
// whose control points must all be included). Reading coords as flat x,y pairs
// is WRONG for rectangles and misses curve extents.
function pathBBox(ops, coords, devM) {
  let r = null, ci = 0;
  const add = (x, y) => {
    const p = Util.applyTransform([x, y], devM);
    const pt = rect(p[0], p[1], p[0], p[1]);
    r = r ? rUnion(r, pt) : pt;
  };
  for (const op of ops) {
    switch (op) {
      case PATH.moveTo: case PATH.lineTo:
        add(coords[ci], coords[ci + 1]); ci += 2; break;
      case PATH.curveTo:
        add(coords[ci], coords[ci + 1]); add(coords[ci + 2], coords[ci + 3]); add(coords[ci + 4], coords[ci + 5]); ci += 6; break;
      case PATH.curveTo2: case PATH.curveTo3:
        add(coords[ci], coords[ci + 1]); add(coords[ci + 2], coords[ci + 3]); ci += 4; break;
      case PATH.rectangle: {
        const x = coords[ci], y = coords[ci + 1], w = coords[ci + 2], h = coords[ci + 3];
        add(x, y); add(x + w, y + h); ci += 4; break;
      }
      case PATH.closePath: break;
      default: break;
    }
  }
  return r;
}

// --- small geometry helpers ---------------------------------------------------
const rect = (x0, y0, x1, y1) => ({
  x0: Math.min(x0, x1), y0: Math.min(y0, y1),
  x1: Math.max(x0, x1), y1: Math.max(y0, y1),
});
const rArea = (r) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const rUnion = (a, b) => rect(Math.min(a.x0, b.x0), Math.min(a.y0, b.y0), Math.max(a.x1, b.x1), Math.max(a.y1, b.y1));
function rIntersect(a, b) {
  const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
  return (x1 <= x0 || y1 <= y0) ? null : rect(x0, y0, x1, y1);
}
const rInflate = (r, d) => rect(r.x0 - d, r.y0 - d, r.x1 + d, r.y1 + d);

// =============================================================================
// PUBLIC API
// =============================================================================
/**
 * @param {ArrayBuffer} data         raw PDF bytes
 * @param {object}      opts         conversion options (see app.js)
 * @param {object}      hooks        { onProgress(frac,msg), ocr(blob)->Promise<string>|null }
 * @returns {Promise<{markdown:string, images:Array<{name,blob}>, meta:object, warnings:string[]}>}
 */
export async function convertPdf(data, opts = {}, hooks = {}) {
  const onProgress = hooks.onProgress || (() => {});
  const ocr = opts.ocr ? hooks.ocr : null;
  const warnings = [];

  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl: v('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: v('pdfjs/standard_fonts/'),
    isEvalSupported: false,     // keep CSP tight: no eval needed
    useSystemFonts: false,      // never reach out to OS/network fonts
  });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (e) {
    try { await loadingTask.destroy(); } catch { /* noop */ }
    const name = e && e.name;
    if (name === 'PasswordException') {
      throw new Error('This PDF is password-protected. Please remove the password and try again.');
    }
    if (name === 'InvalidPDFException') {
      throw new Error('This file does not appear to be a valid PDF.');
    }
    throw new Error(`Could not open the PDF (${e && e.message ? e.message : e}).`);
  }

  const docMeta = await safeMeta(pdf);
  docMeta.sourceName = opts.sourceName || '';
  const images = [];
  const pageMarkdowns = [];

  const total = pdf.numPages;
  try {
    for (let p = 1; p <= total; p++) {
      onProgress((p - 1) / total, `Page ${p} / ${total}…`);
      // Isolate each page: one corrupt/oversized page must not destroy the whole
      // document — record a warning and keep going so the rest still converts.
      try {
        const page = await pdf.getPage(p);
        try {
          const res = await convertPage(page, p, opts, { images, ocr, warnings, onProgress, total });
          pageMarkdowns.push(res.markdown);
        } finally {
          page.cleanup();
        }
      } catch (e) {
        warnings.push(`Page ${p}: conversion failed (${e && e.message ? e.message : e}); page skipped.`);
        pageMarkdowns.push('');
      }
    }

    onProgress(0.98, 'Assembling Markdown…');
    const md = assembleDocument(pageMarkdowns, docMeta, opts);
    onProgress(1, 'Done');
    return { markdown: md, images, meta: docMeta, warnings: dedupe(warnings) };
  } finally {
    // Always release the worker/document, even if assembly throws.
    try { await pdf.destroy(); } catch { /* already gone */ }
  }
}

// =============================================================================
// PER-PAGE CONVERSION
// =============================================================================
async function convertPage(page, pageNum, opts, ctx) {
  const viewport = page.getViewport({ scale: 1 });
  const pageW = viewport.width, pageH = viewport.height;
  const pageArea = pageW * pageH;

  // ---- 1. TEXT ------------------------------------------------------------
  const textContent = await page.getTextContent();
  const lines = buildLines(textContent, viewport);
  const bodyFont = medianBodyFont(lines) || 12;

  // ---- 2. OPERATOR LIST (shared by graphics + font-style detection) -------
  let opList = null;
  if (opts.imageMode === 'extract' || opts.emphasis) {
    try { opList = await page.getOperatorList(); }
    catch (e) { ctx.warnings.push(`Page ${pageNum}: operator scan failed (${e.message}).`); }
  }
  const fontStyles = (opList && opts.emphasis) ? deriveFontStyles(opList, page) : null;

  let regions = [];
  if (opts.imageMode === 'extract' && opList) {
    try {
      regions = collectRegions(opList, viewport, pageArea, opts);
    } catch (e) {
      ctx.warnings.push(`Page ${pageNum}: image scan failed (${e.message}). Text still extracted.`);
    }
  }

  // Detect a "scanned" page: essentially no real text but a big image covering it.
  const textChars = lines.reduce((n, l) => n + l.text.length, 0);
  const bigCover = regions.find(r => rArea(r.bbox) > 0.55 * pageArea);
  const isScanned = textChars < 12 && !!bigCover;

  const consumed = new Set();             // line indices consumed as captions/tables

  // ---- 3. TABLES ---------------------------------------------------------
  // Detect tables from the text BEFORE captions and rasterization. A ruled
  // table's grid lines otherwise look like a vector "diagram", so we drop any
  // image region that sits on top of a detected table — and do it before
  // caption matching so a table region can't steal a nearby figure's caption.
  const docLeft = mode(lines.filter(l => l.text).map(l => Math.round(l.x0))) || 0;
  const maxRight = Math.max(docLeft + 1, ...lines.filter(l => l.text).map(l => l.x1));
  const pctx = { bodyFont, docLeft, textWidth: maxRight - docLeft, pageWidth: pageW, fontStyles };
  const tables = opts.tables ? detectTables(lines, consumed, pctx) : [];
  if (tables.length) {
    regions = regions.filter(reg => !tables.some(t => {
      const inter = rIntersect(reg.bbox, t.bbox);
      return inter && rArea(inter) > 0.4 * rArea(reg.bbox);
    }));
  }

  // ---- 3b. CAPTIONS / ALT TEXT -------------------------------------------
  const structAlts = opts.altText ? await safeStructAlts(page) : [];
  let altCursor = 0;
  if (opts.captions) {
    for (const reg of regions) {
      const cap = findCaption(reg.bbox, lines, bodyFont, consumed);
      if (cap) { reg.caption = cap.text; cap.indices.forEach(i => consumed.add(i)); }
    }
  }
  if (opts.altText) {
    for (const reg of regions) {
      if (!reg.caption && altCursor < structAlts.length) reg.alt = structAlts[altCursor++];
    }
  }

  // ---- 4. RASTERIZE the page once (only if we need pixels) ----------------
  let pageCanvas = null;
  const needsRender = regions.length > 0 || (isScanned && ctx.ocr);
  if (needsRender) {
    pageCanvas = await renderPage(page, pageW, pageH);
    for (const reg of regions) {
      const blob = await cropToBlob(pageCanvas, reg.bbox, reg.kind);
      if (!blob) { reg.skip = true; continue; }
      reg.name = `images/page-${pageNum}-${reg.kind === 'diagram' ? 'fig' : 'img'}-${reg.idx}.${blob.type === 'image/png' ? 'png' : 'jpg'}`;
      reg.blob = blob;
      ctx.images.push({ name: reg.name, blob });
    }
    regions = regions.filter(r => !r.skip);
  }

  // ---- 5. OCR (optional) --------------------------------------------------
  if (ctx.ocr) {
    if (isScanned && pageCanvas) {
      ctx.onProgress(undefined, `Page ${pageNum}: OCR (scanned page)…`);
      const full = await canvasToBlob(pageCanvas, 'image/png');
      const text = (await ctx.ocr(full)) || '';
      if (text.trim()) {
        // Replace the (empty) text flow with OCR'd paragraphs.
        return { markdown: ocrTextToMarkdown(text), bodyFont };
      }
    }
    for (const reg of regions) {
      if (!reg.blob) continue;
      ctx.onProgress(undefined, `Page ${pageNum}: OCR image…`);
      const text = (await ctx.ocr(reg.blob)) || '';
      if (text.trim()) reg.ocr = text.trim();
    }
  }

  // Text that lies inside a captured diagram is part of the figure now — drop it
  // from the prose flow to avoid duplicating it next to the rasterized diagram.
  for (const reg of regions) {
    if (reg.kind !== 'diagram' || !reg.name) continue;
    for (let i = 0; i < lines.length; i++) {
      if (consumed.has(i)) continue;
      const l = lines[i];
      const cx = (l.x0 + l.x1) / 2, cy = l.baseline;
      if (cx > reg.bbox.x0 && cx < reg.bbox.x1 && cy > reg.bbox.y0 && cy < reg.bbox.y1) consumed.add(i);
    }
  }

  // ---- 6. INTERLEAVE text blocks + tables + images by vertical position ---
  const blocks = groupBlocks(lines, consumed, bodyFont, opts);

  const elements = [];
  for (const b of blocks) elements.push({ top: b.top, kind: 'text', block: b });
  for (const r of regions) elements.push({ top: r.bbox.y0, kind: 'media', region: r });
  for (const t of tables) elements.push({ top: t.top, kind: 'table', table: t });
  elements.sort((a, b) => a.top - b.top);

  const out = [];
  const headingScale = opts.headings ? buildHeadingScale(blocks, bodyFont) : null;
  for (const el of elements) {
    if (el.kind === 'text') {
      const t = renderBlock(el.block, pctx, headingScale, opts);
      if (t) out.push(t);
    } else if (el.kind === 'table') {
      out.push(renderTable(el.table));
    } else {
      out.push(renderMedia(el.region, opts));
    }
  }
  return { markdown: out.join('\n\n'), bodyFont };
}

// Map pdf.js loaded font ids -> {bold, italic} using the resolved font objects
// (their real PostScript names / descriptor flags encode the style).
function deriveFontStyles(opList, page) {
  const ids = new Set();
  for (let i = 0; i < opList.fnArray.length; i++) {
    if (opList.fnArray[i] === OPS.setFont) ids.add(opList.argsArray[i][0]);
  }
  const map = new Map();
  for (const id of ids) {
    try {
      if (!page.commonObjs.has(id)) continue;
      const f = page.commonObjs.get(id);
      const name = (f && (f.name || f.loadedName)) || '';
      map.set(id, {
        bold: !!(f && f.bold) || /bold|black|semibold|heavy/i.test(name),
        italic: !!(f && f.italic) || /italic|oblique/i.test(name),
      });
    } catch { /* font not resolvable; skip */ }
  }
  return map;
}

// =============================================================================
// TEXT: lines, blocks, classification
// =============================================================================
function buildLines(textContent, viewport) {
  const items = [];
  for (const it of textContent.items) {
    if (!('str' in it)) continue;                 // skip marked-content markers
    const m = Util.transform(viewport.transform, it.transform);
    const x = m[4];
    const baseline = m[5];
    const fontH = Math.hypot(m[2], m[3]) || it.height || 0;
    const width = it.width || 0;
    if (it.str === '' && !it.hasEOL) continue;
    items.push({
      str: it.str, x, baseline, fontH, width,
      right: x + width, fontName: it.fontName, eol: it.hasEOL,
    });
  }
  // group into lines by baseline proximity
  items.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const lines = [];
  let cur = null;
  for (const it of items) {
    const tol = Math.max(2, (it.fontH || 10) * 0.5);
    if (cur && Math.abs(it.baseline - cur.baseline) <= tol) {
      cur.items.push(it);
      cur.baseline = (cur.baseline * (cur.items.length - 1) + it.baseline) / cur.items.length;
    } else {
      if (cur) lines.push(finalizeLine(cur));
      cur = { baseline: it.baseline, items: [it] };
    }
  }
  if (cur) lines.push(finalizeLine(cur));
  lines.sort((a, b) => a.baseline - b.baseline);
  return lines;
}

function finalizeLine(cur) {
  const items = cur.items.sort((a, b) => a.x - b.x);
  let text = '';
  let prev = null;
  for (const it of items) {
    if (prev) {
      const gap = it.x - prev.right;
      const space = (it.fontH || 10) * 0.25;
      const endsSp = /\s$/.test(text);
      const startsSp = /^\s/.test(it.str);
      if (gap > space && !endsSp && !startsSp) text += ' ';
    }
    text += it.str;
    prev = it;
  }
  const x0 = items[0].x;
  const x1 = Math.max(...items.map(i => i.right));
  const fontH = median(items.map(i => i.fontH).filter(Boolean)) || 10;
  const fontNames = items.map(i => i.fontName);
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    rawItems: items,
    x0, x1, baseline: cur.baseline, top: cur.baseline - fontH, fontH,
    fontName: mode(fontNames),
  };
}

function groupBlocks(lines, consumed, bodyFont, opts) {
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) { if (cur) { blocks.push(cur); cur = null; } continue; }
    const ln = lines[i];
    if (!ln.text) { if (cur) { blocks.push(cur); cur = null; } continue; }
    const prev = cur ? cur.lines[cur.lines.length - 1] : null;
    let split = false;
    if (prev) {
      const gap = ln.top - prev.baseline;            // space between lines
      const lineH = Math.max(prev.fontH, ln.fontH);
      if (gap > lineH * 0.9) split = true;           // paragraph break
      if (Math.abs(ln.fontH - prev.fontH) > Math.max(1, bodyFont * 0.18)) split = true; // size change
      if (isListMarker(ln.text) && !isListMarker(prev.text)) split = true;
    }
    if (!cur || split) { if (cur) blocks.push(cur); cur = { lines: [ln] }; }
    else cur.lines.push(ln);
  }
  if (cur) blocks.push(cur);
  // finalize block metrics
  for (const b of blocks) {
    b.top = Math.min(...b.lines.map(l => l.top));
    b.fontH = median(b.lines.map(l => l.fontH));
    b.x0 = Math.min(...b.lines.map(l => l.x0));
    b.text = b.lines.map(l => l.text).join(' ');
  }
  return blocks;
}

// ---- heading scale: rank distinct large font sizes into h1..h6 -------------
function buildHeadingScale(blocks, bodyFont) {
  const sizes = new Set();
  for (const b of blocks) {
    if (b.lines.length <= 2 && b.fontH > bodyFont * 1.12) sizes.add(Math.round(b.fontH * 2) / 2);
  }
  const ranked = [...sizes].sort((a, b) => b - a).slice(0, 6);
  const map = new Map();
  ranked.forEach((sz, i) => map.set(sz, i + 1));
  return { map, ranked, bodyFont };
}

function headingLevelFor(block, scale) {
  if (!scale || block.lines.length > 2) return 0;
  if (block.fontH <= scale.bodyFont * 1.12) return 0;
  // nearest ranked size
  let best = null, bestD = Infinity;
  for (const sz of scale.ranked) {
    const d = Math.abs(sz - block.fontH);
    if (d < bestD) { bestD = d; best = sz; }
  }
  if (best == null) return 0;
  const lvl = scale.map.get(best) || 0;
  return Math.min(6, lvl);
}

// =============================================================================
// BLOCK -> MARKDOWN
// =============================================================================
function renderBlock(block, pctx, headingScale, opts) {
  const bodyFont = pctx.bodyFont;
  const text = block.text.trim();
  if (!text) return '';

  // Heading? (use plain text — the leading #'s already convey emphasis)
  const lvl = headingLevelFor(block, headingScale);
  if (lvl) return '#'.repeat(lvl) + ' ' + block.lines.map(l => l.text).join(' ').trim();

  // List with explicit markers (bullets / numbers in the text)?
  if (opts.lists && block.lines.some(l => isListMarker(l.text)) &&
      block.lines.every(l => isListMarker(l.text) || l.text === '')) {
    return renderMarkerList(block, bodyFont);
  }

  // Marker-less list: a block of short lines indented past the body margin
  // (common when a PDF draws bullet glyphs as vector dots, so they aren't text).
  if (opts.lists && looksLikeIndentedList(block, pctx)) {
    return block.lines.filter(l => l.text).map(l => '- ' + l.text).join('\n');
  }

  // Monospace block -> code fence
  if (block.fontName && /mono|courier|consol/i.test(block.fontName) && block.lines.length > 1) {
    return '```\n' + block.lines.map(l => l.text).join('\n') + '\n```';
  }

  return inline(block, opts, pctx);
}

function renderMarkerList(block, bodyFont) {
  const baseIndent = Math.min(...block.lines.filter(l => l.text).map(l => l.x0));
  return block.lines.filter(l => l.text).map(l => {
    const depth = Math.max(0, Math.round((l.x0 - baseIndent) / (bodyFont * 1.2)));
    const m = l.text.match(/^(\s*)([•‣◦⁃∙\-\*·▪●○–■]|(\d+|[a-zA-Z]|[ivxlcdm]+)[.\)])\s+(.*)$/);
    const indent = '  '.repeat(depth);
    if (!m) return indent + '- ' + l.text;
    // Ordered only when the marker is itself an enumerator (digit/letter/roman +
    // '.'/')'); bullet glyphs like - * – are never ordered.
    const ordered = /^(\d+|[a-zA-Z]|[ivxlcdm]+)[.\)]$/.test(m[2]);
    const marker = ordered ? '1.' : '-';
    return `${indent}${marker} ${m[4]}`;
  }).join('\n');
}

// Heuristic: a whole block indented well past the dominant left margin, made of
// multiple short lines, reads as a list rather than a wrapped paragraph (whose
// lines run close to full column width).
function looksLikeIndentedList(block, pctx) {
  if (block.lines.length < 2) return false;
  const indented = block.x0 > pctx.docLeft + pctx.bodyFont * 0.6;
  if (!indented) return false;
  const colW = pctx.textWidth || pctx.pageWidth;
  const allShort = block.lines.filter(l => l.text).every(l => (l.x1 - l.x0) < 0.72 * colW);
  return allShort;
}

// Inline emphasis using resolved font styles (real PostScript names / flags).
// Spacing mirrors finalizeLine's gap logic so words split across font runs are
// NOT broken by spurious spaces, and emphasis markers hug the text (separators
// are emitted OUTSIDE the markers, so `**Hello**!` and `Hello **World**` are
// both valid).
const wrapFor = (s) => (s === 'bi' ? '***' : s === 'b' ? '**' : s === 'i' ? '*' : '');

function inline(block, opts, pctx) {
  const styles = pctx && pctx.fontStyles;
  if (!opts.emphasis || !styles) return block.lines.map(l => l.text).join(' ');

  // 1) tokens: each visible item with its style and the separator that precedes it
  const tokens = [];
  let firstOverall = true;
  for (const line of block.lines) {
    let prev = null;
    for (const it of line.rawItems) {
      if (!it.str) { continue; }
      const st = styles.get(it.fontName) || { bold: false, italic: false };
      const style = (st.bold && st.italic) ? 'bi' : st.bold ? 'b' : st.italic ? 'i' : '';
      let sep = '';
      if (firstOverall) sep = '';
      else if (prev) sep = (it.x - prev.right) > (it.fontH || 10) * 0.25 ? ' ' : '';
      else sep = ' ';                       // line break within the block
      tokens.push({ style, sep, str: it.str });
      prev = it; firstOverall = false;
    }
  }

  // 2) group consecutive same-style tokens into runs (separators included)
  const runs = [];
  for (const t of tokens) {
    if (!runs.length || runs[runs.length - 1].style !== t.style) runs.push({ style: t.style, text: '' });
    runs[runs.length - 1].text += t.sep + t.str;
  }

  // 3) emit; for styled runs keep INTERNAL spacing but move leading/trailing
  // whitespace OUTSIDE the markers (CommonMark rejects `** text **`).
  let out = '';
  for (const r of runs) {
    if (!r.style) { out += r.text; continue; }
    const m = r.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    out += m[1] + (m[2] ? wrapFor(r.style) + m[2] + wrapFor(r.style) : '') + m[3];
  }
  return out.replace(/\s+/g, ' ').trim();
}

function isListMarker(t) {
  return /^\s*([•‣◦⁃∙·▪●○■–]|[-\*]\s|\(?(\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,4})[.\)])\s+/.test(t);
}

// =============================================================================
// TABLES: reconstruct GFM tables from column-aligned text runs
// =============================================================================
// Strategy: a table is a run of consecutive lines that each split into >= 2
// "cells" (segments separated by wide horizontal gaps), where the cell start
// positions line up into consistent columns across rows. Guards (short cells,
// fill ratio, column stability) keep ordinary prose and 2-column page layouts
// from being misread as tables.

function detectTables(lines, consumed, pctx) {
  const bodyFont = pctx.bodyFont;
  const cand = lines.map((l, idx) => {
    if (consumed.has(idx) || !l.text) return null;
    const segs = lineSegments(l, bodyFont);
    return segs.length >= 2 ? { idx, line: l, segs } : null;
  });

  const tables = [];
  let i = 0;
  while (i < cand.length) {
    if (!cand[i]) { i++; continue; }
    // gather a run of consecutive candidate rows with regular vertical spacing
    const run = [cand[i]];
    let j = i + 1;
    while (j < cand.length && cand[j]) {
      const prev = run[run.length - 1].line, cur = cand[j].line;
      if (cur.top - prev.baseline > Math.max(prev.fontH, cur.fontH) * 2.0) break;
      run.push(cand[j]); j++;
    }
    let made = false;
    if (run.length >= 2) {
      const tbl = buildTable(run, pctx);
      if (tbl) { tables.push(tbl); run.forEach(r => consumed.add(r.idx)); i = j; made = true; }
    }
    if (!made) i++;
  }
  return tables;
}

// Split a line into cells: items separated by a gap wider than a column break.
function lineSegments(line, bodyFont) {
  const colGap = Math.max(bodyFont * 1.1, 14);
  const wordGap = (bodyFont || 10) * 0.25;
  const segs = [];
  let cur = null;
  for (const it of line.rawItems) {
    if (!it.str.trim()) continue;
    if (cur && (it.x - cur.x1) <= colGap) {
      cur.text += (it.x - cur.x1 > wordGap ? ' ' : '') + it.str;
      cur.x1 = it.right;
    } else {
      if (cur) segs.push(cur);
      cur = { x0: it.x, x1: it.right, text: it.str };
    }
  }
  if (cur) segs.push(cur);
  return segs.map(s => ({ x0: s.x0, text: s.text.replace(/\s+/g, ' ').trim() })).filter(s => s.text);
}

function buildTable(run, pctx) {
  const bodyFont = pctx.bodyFont;
  const starts = [];
  for (const r of run) for (const s of r.segs) starts.push(s.x0);
  const cols = clusterPositions(starts, bodyFont * 1.5);
  if (cols.length < 2 || cols.length > 12) return null;

  const rows = run.map(r => {
    const cells = new Array(cols.length).fill('');
    for (const s of r.segs) {
      const ci = nearestIndex(cols, s.x0);
      cells[ci] = cells[ci] ? `${cells[ci]} ${s.text}` : s.text;
    }
    return cells;
  });

  // validation: enough multi-cell rows, decent fill, short cells (not prose cols)
  if (rows.filter(c => c.filter(Boolean).length >= 2).length < 2) return null;
  const cells = rows.flat().filter(Boolean);
  const avgLen = cells.reduce((n, c) => n + c.length, 0) / cells.length;
  if (avgLen > 40) return null;
  const fill = cells.length / (rows.length * cols.length);
  if (fill < 0.5) return null;

  const x0 = Math.min(...run.flatMap(r => r.segs.map(s => s.x0)));
  const x1 = Math.max(...run.map(r => r.line.x1));
  return { rows, top: run[0].line.top, bbox: rect(x0, run[0].line.top, x1, run[run.length - 1].line.baseline) };
}

// 1-D greedy clustering of x positions -> sorted cluster centers.
function clusterPositions(values, tol) {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];
  let group = [sorted[0]];
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] - group[group.length - 1] <= tol) group.push(sorted[k]);
    else { clusters.push(group); group = [sorted[k]]; }
  }
  clusters.push(group);
  return clusters.map(g => g.reduce((a, b) => a + b, 0) / g.length);
}

function nearestIndex(centers, x) {
  let best = 0, bestD = Infinity;
  for (let c = 0; c < centers.length; c++) {
    const d = Math.abs(centers[c] - x);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function renderTable(table) {
  const esc = (c) => htmlAngle(String(c)).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const header = table.rows[0].map(esc);
  const out = [
    '| ' + header.join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
  ];
  for (let r = 1; r < table.rows.length; r++) out.push('| ' + table.rows[r].map(esc).join(' | ') + ' |');
  return out.join('\n');
}

// =============================================================================
// GRAPHICS: walk operator list, collect raster + vector regions
// =============================================================================
function collectRegions(opList, viewport, pageArea, opts) {
  const fn = opList.fnArray, args = opList.argsArray;

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const base = viewport.transform;             // PDF user space -> device (scale 1)
  const dev = (m) => Util.transform(base, m);  // combined CTM in device space

  const rasters = [];
  const vmarks = [];
  let pendingPath = null;

  const unitBBox = (cm) => {
    const d = dev(cm);
    const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(p => Util.applyTransform(p, d));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  };

  for (let i = 0; i < fn.length; i++) {
    const op = fn[i];
    switch (op) {
      case OPS.save: stack.push(ctm.slice()); break;
      case OPS.restore: ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case OPS.transform: ctm = Util.transform(ctm, args[i]); break;

      case OPS.paintImageXObject:
      case OPS.paintInlineImage:
      case OPS.paintImageXObjectRepeat:
        rasters.push({ bbox: unitBBox(ctm), kind: 'image' });
        break;
      case OPS.paintImageMaskXObject: {
        // big masks = real images; small ones are vector-ish marks
        const bb = unitBBox(ctm);
        if (rArea(bb) > 0.05 * pageArea) rasters.push({ bbox: bb, kind: 'image' });
        else vmarks.push(bb);
        break;
      }

      case OPS.constructPath:
        pendingPath = pathBBox(args[i][0] || [], args[i][1] || [], dev(ctm));
        break;
      default:
        if (PAINT_OPS.has(op) && pendingPath) { vmarks.push(pendingPath); pendingPath = null; }
        else if (op === OPS.endPath) pendingPath = null;
    }
  }

  // cluster vector marks into diagram regions
  let regions = rasters.map(r => ({ ...r }));
  if (opts.diagrams) {
    const diagrams = clusterVectorMarks(vmarks, viewport, pageArea);
    // drop diagram clusters that overlap an existing raster image
    for (const d of diagrams) {
      const overlapsRaster = rasters.some(rr => {
        const inter = rIntersect(rr.bbox, d.bbox);
        return inter && rArea(inter) > 0.5 * rArea(d.bbox);
      });
      if (!overlapsRaster) regions.push(d);
    }
  }

  // Filter trivial regions (too small / sliver-shaped) and obvious full-page
  // backgrounds, then de-overlap.
  regions = regions
    .filter(r => rArea(r.bbox) > 0.008 * pageArea
              && Math.min(r.bbox.x1 - r.bbox.x0, r.bbox.y1 - r.bbox.y0) > 24
              && Math.max(r.bbox.x1 - r.bbox.x0, r.bbox.y1 - r.bbox.y0) > 60)
    .filter(r => rArea(r.bbox) < 0.95 * pageArea);

  regions = mergeOverlapping(regions);
  regions.forEach((r, i) => { r.idx = i + 1; });
  return regions;
}

// Pages drawn as dense vector art can emit thousands of path marks; the
// pairwise merge below is ~O(n^2) per pass, so bound the input. Keeping the
// largest-area marks preserves the shapes that define a figure's extent while
// dropping fine detail (which clusters into the same regions anyway).
const MAX_VECTOR_MARKS = 800;

function clusterVectorMarks(marks, viewport, pageArea) {
  // ignore page-spanning thin rules / borders
  const pageW = viewport.width, pageH = viewport.height;
  let filtered = marks.filter(m => {
    const w = m.x1 - m.x0, h = m.y1 - m.y0;
    if (h < 3 && w > 0.5 * pageW) return false;   // horizontal rule
    if (w < 3 && h > 0.5 * pageH) return false;   // vertical rule
    if (rArea(m) > 0.92 * pageArea) return false;  // full-page background
    return true;
  });
  if (!filtered.length) return [];
  if (filtered.length > MAX_VECTOR_MARKS) {
    filtered = filtered.sort((a, b) => rArea(b) - rArea(a)).slice(0, MAX_VECTOR_MARKS);
  }

  // iterative merge of marks whose inflated boxes overlap
  const gap = Math.max(12, Math.min(pageW, pageH) * 0.025);
  let boxes = filtered.map(m => ({ bbox: m, n: 1 }));
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (rIntersect(rInflate(boxes[i].bbox, gap), rInflate(boxes[j].bbox, gap))) {
          boxes[i] = { bbox: rUnion(boxes[i].bbox, boxes[j].bbox), n: boxes[i].n + boxes[j].n };
          boxes.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  // keep clusters that look like real figures: enough marks OR enough area
  return boxes
    .filter(b => (b.n >= 4 && rArea(b.bbox) > 0.012 * pageArea) || rArea(b.bbox) > 0.04 * pageArea)
    .map(b => ({ bbox: b.bbox, kind: 'diagram' }));
}

function mergeOverlapping(regions) {
  const out = [];
  for (const r of regions.sort((a, b) => rArea(b.bbox) - rArea(a.bbox))) {
    let merged = false;
    for (const o of out) {
      const inter = rIntersect(r.bbox, o.bbox);
      if (inter && rArea(inter) > 0.6 * Math.min(rArea(r.bbox), rArea(o.bbox))) {
        o.bbox = rUnion(o.bbox, r.bbox);
        if (r.kind === 'image') o.kind = 'image';
        merged = true; break;
      }
    }
    if (!merged) out.push({ ...r });
  }
  return out;
}

// =============================================================================
// CAPTIONS / ALT
// =============================================================================
function findCaption(bbox, lines, bodyFont, consumed) {
  // Generous vertical window: figure bounding boxes (esp. vector diagrams) often
  // underestimate the visual figure, leaving whitespace before the caption. We
  // still pick the NEAREST matching "Figure N"/"Table N" line, so this stays safe.
  const gap = bodyFont * 6;
  const cx0 = bbox.x0, cx1 = bbox.x1;
  const horizOverlap = (l) => Math.min(l.x1, cx1) - Math.max(l.x0, cx0) > 0.2 * (cx1 - cx0)
                              || (l.x0 + l.x1) / 2 >= cx0 && (l.x0 + l.x1) / 2 <= cx1;

  // search below first (most common), then above
  for (const dir of ['below', 'above']) {
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < lines.length; i++) {
      if (consumed.has(i)) continue;
      const l = lines[i];
      if (!l.text || !FIGURE_RE.test(l.text)) continue;
      if (!horizOverlap(l)) continue;
      const dist = dir === 'below' ? l.top - bbox.y1 : bbox.y0 - l.baseline;
      if (dist > 0 && dist < gap && dist < bestDist) { bestDist = dist; best = i; }
    }
    if (best >= 0) {
      // include continuation lines of the same caption block
      const indices = [best];
      let text = lines[best].text;
      for (let j = best + 1; j < lines.length; j++) {
        if (consumed.has(j)) break;
        const l = lines[j], prev = lines[j - 1];
        const cont = l.text && !FIGURE_RE.test(l.text) && (l.top - prev.baseline) < bodyFont * 0.8
                     && Math.abs(l.fontH - lines[best].fontH) < 1.5 && horizOverlap(l);
        if (!cont) break;
        text += ' ' + l.text; indices.push(j);
      }
      return { text: text.replace(/\s+/g, ' ').trim(), indices };
    }
  }
  return null;
}

async function safeStructAlts(page) {
  try {
    const tree = await page.getStructTree();
    const alts = [];
    (function walk(n) {
      if (!n) return;
      if (n.alt && typeof n.alt === 'string') alts.push(n.alt.trim());
      (n.children || []).forEach(walk);
    })(tree);
    return alts;
  } catch { return []; }
}

// =============================================================================
// RENDER MEDIA -> MARKDOWN
// =============================================================================
function renderMedia(reg, opts) {
  if (opts.imageMode !== 'extract' || !reg.name) return '';
  const altSource = reg.caption || reg.alt || (reg.kind === 'diagram' ? 'Diagram' : 'Image');
  const alt = mdEscapeAlt(altSource);
  let s = `![${alt}](${reg.name})`;
  if (reg.caption) s += `\n\n*${mdEscapeText(reg.caption)}*`;
  if (reg.ocr) {
    // OCR text is untrusted and is placed inside a raw <details> block, so it
    // must be HTML-escaped as well as paragraph-normalized.
    const body = paragraphs(reg.ocr).map(htmlAngle).join('\n\n');
    if (body.length > 1) {
      s += `\n\n<details><summary>Text recognized in this ${reg.kind === 'diagram' ? 'diagram' : 'image'} (OCR)</summary>\n\n${body}\n\n</details>`;
    }
  }
  return s;
}

// Split raw OCR text into trimmed, single-line paragraphs.
function paragraphs(text) {
  return text.split(/\n{2,}/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
}

function ocrTextToMarkdown(text) {
  return paragraphs(text).map(htmlAngle).join('\n\n');
}

// =============================================================================
// CANVAS / RASTERIZATION
// =============================================================================
async function renderPage(page, pageW, pageH) {
  const maxDim = 4000;
  const scale = Math.min(2, maxDim / Math.max(pageW, pageH));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const cctx = canvas.getContext('2d', { alpha: false });
  cctx.fillStyle = '#ffffff';
  cctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: cctx, viewport, background: '#ffffff' }).promise;
  canvas._scale = scale;
  return canvas;
}

async function cropToBlob(pageCanvas, bbox, kind) {
  const s = pageCanvas._scale || 1;
  const pad = 4;
  let x0 = Math.max(0, Math.floor(bbox.x0 * s) - pad);
  let y0 = Math.max(0, Math.floor(bbox.y0 * s) - pad);
  let x1 = Math.min(pageCanvas.width, Math.ceil(bbox.x1 * s) + pad);
  let y1 = Math.min(pageCanvas.height, Math.ceil(bbox.y1 * s) + pad);
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d', { alpha: false });
  cx.drawImage(pageCanvas, x0, y0, w, h, 0, 0, w, h);
  // diagrams -> PNG (sharp lines/text); raster images -> JPEG (smaller)
  const type = kind === 'diagram' ? 'image/png' : 'image/jpeg';
  return canvasToBlob(c, type, 0.9);
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b || null), type, quality);
  });
}

// =============================================================================
// DOCUMENT ASSEMBLY + METADATA
// =============================================================================
function assembleDocument(pages, meta, opts) {
  const parts = [];
  if (opts.frontMatter) {
    const fm = ['---'];
    if (meta.title) fm.push(`title: ${yaml(meta.title)}`);
    if (meta.author) fm.push(`author: ${yaml(meta.author)}`);
    if (meta.sourceName) fm.push(`source: ${yaml(meta.sourceName)}`);
    fm.push(`converted_by: pdf-to-markdown (offline)`);
    fm.push('---');
    parts.push(fm.join('\n'));
  }
  const sep = opts.pageRules ? '\n\n---\n\n' : '\n\n';
  parts.push(pages.map(p => p.trim()).filter(Boolean).join(sep));
  return parts.join('\n\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

async function safeMeta(pdf) {
  try {
    const { info } = await pdf.getMetadata();
    let title = (info && info.Title || '').trim();
    if (/^(about:blank|untitled|microsoft word -.*|document\d*)$/i.test(title)) title = '';
    return {
      title,
      author: (info && info.Author || '').trim(),
      sourceName: '',
    };
  } catch { return { title: '', author: '', sourceName: '' }; }
}

// =============================================================================
// little utilities
// =============================================================================
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function mode(a) { const m = new Map(); let best = a[0], bn = 0; for (const x of a) { const n = (m.get(x) || 0) + 1; m.set(x, n); if (n > bn) { bn = n; best = x; } } return best; }
function medianBodyFont(lines) { const fs = []; for (const l of lines) if (l.text && l.text.length > 3) fs.push(l.fontH); return median(fs); }
function dedupe(a) { return [...new Set(a)]; }
// Neutralize HTML angle brackets so untrusted PDF-derived text (captions, alt,
// OCR output) can never become live markup when the Markdown is previewed or
// rendered downstream. Escaping '<'/'>' defeats tag and autolink injection while
// leaving '&' intact for fidelity (markdown renderers escape it anyway).
function htmlAngle(s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function mdEscapeAlt(s) { return htmlAngle(String(s).replace(/[\[\]\r\n]+/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200); }
function mdEscapeText(s) { return htmlAngle(String(s).replace(/[\r\n]+/g, ' ')).replace(/\s+/g, ' ').trim(); }
function yaml(s) { return /[:#"'\n]/.test(s) ? JSON.stringify(s) : s; }
