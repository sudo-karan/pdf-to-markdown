# PDF → Markdown (offline, air-gapped)

A 100% offline, browser-based app that converts PDFs to Markdown — **including
images, vector diagrams, and their captions/labels**. Everything runs locally in
your browser. No data ever leaves your machine, no servers, no APIs, no CDNs.
You can disconnect from the network entirely and it still works.

---

## What about images and their labels? (the important part)

A PDF stores images and text, but it does **not** store a semantic "label" that
says *"this is a diagram of X."* So here is exactly what this tool does and does
not do, all fully offline:

| What you get | Status | How it works |
|---|---|---|
| **Embed raster images** (photos, charts saved as images) | ✅ | Extracted from the page and saved/inlined, placed where they appear. |
| **Embed vector diagrams** (line art, flowcharts, charts drawn with shapes) | ✅ | Detected from the PDF's drawing operators, then rasterized to PNG. |
| **Existing captions** ("Figure 1: …", "Table 2: …") | ✅ | Matched to the nearest image by position + keyword, attached as the image caption **and** its alt text. |
| **Embedded alt-text** from tagged/accessible PDFs | ✅ (when present) | Read from the PDF structure tree. Most PDFs aren't tagged, so this is often empty. |
| **Text *inside* an image/diagram** (e.g. labels on a chart) | ✅ with OCR on | Optional offline OCR (Tesseract) reads the text and stores it under the image. |
| **Scanned / image-only PDFs** | ✅ with OCR on | Each page image is OCR'd into Markdown text. |
| **An AI description of what a diagram *depicts*** ("a flowchart of login→auth→home") | ❌ | This needs a vision-language model. It is intentionally **not** bundled (it would add hundreds of MB–GB and require WebGPU). The architecture leaves room to add a local model later. |

**Bottom line:** the Markdown embeds your images and diagrams, attaches any
real captions/labels the PDF already contains, and (with OCR) reads text printed
inside them. It does not *invent* descriptions for unlabeled diagrams — that
would require a local AI model, which is out of scope for this air-gapped build.

Example of what the converter produces for a figure:

```markdown
![Figure 2: Vector flow diagram of the login sequence.](images/page-1-fig-2.png)

*Figure 2: Vector flow diagram of the login sequence.*

<details><summary>Text recognized in this diagram (OCR)</summary>

Login   Auth   Home

</details>
```

---

## Running it

Opening `index.html` directly via `file://` does **not** work — browsers block
web-workers and local file reads under `file://`, and this converter needs them.
Use the tiny bundled server (it binds to localhost only and makes **no** outbound
connections, so you stay air-gapped):

```bash
python3 serve.py            # then open http://localhost:8000
python3 serve.py 9000       # custom port
```

Any static file server works too (e.g. `npx serve`, `php -S localhost:8000`),
as long as it serves `.mjs` as JavaScript and `.wasm` as `application/wasm`.

No build step, no `npm install` — the app is plain HTML/CSS/JS with every
dependency vendored under `vendor/`.

---

## Verifying it's truly air-gapped

1. **Content-Security-Policy.** `index.html` ships a strict CSP with
   `default-src 'none'` and **no http(s) host anywhere** in the policy. The page
   is physically unable to open an internet connection.
2. **See for yourself.** Open DevTools → Network, convert a PDF, and confirm
   there are **zero** external requests (only same-origin `vendor/` assets).
3. **Pull the plug.** Disconnect from the network (or run the machine offline)
   and it works identically.

The included automated test also asserts that converting a PDF produces **no
off-host requests** under the real CSP.

---

## Options

- **Image handling** — extract & embed images/diagrams, or text-only.
- **Capture vector diagrams** — detect and rasterize shape-drawn figures.
- **Detect captions & figure labels** — attach "Figure N"/"Table N" text.
- **Use embedded alt-text** — read accessibility alt-text from tagged PDFs.
- **Run offline OCR** — read text inside images and convert scanned pages
  (Tesseract; the English model is bundled). Slower; first use initializes the
  local model.
- **Headings / lists / bold-italic / front-matter / page rules** — structure
  inference toggles.
- **Output** — a **ZIP** (`.md` + `images/` folder, relative links) or a
  **single self-contained `.md`** with images inlined as base64.

---

## How it works

```
index.html            strict-CSP shell + UI
assets/css/styles.css
assets/js/
  app.js              UI glue, conversion orchestration, ZIP/inline output
  converter.js        the engine: pdf.js text→Markdown, image & vector-diagram
                      extraction, caption/alt association, OCR hooks
  ocr.js              offline Tesseract wrapper (lazy-loaded)
  preview.js          Markdown→HTML preview (marked + sanitizer)
vendor/               all third-party libs + assets, committed for offline use
  pdfjs/              pdf.js build, worker, CMaps, standard fonts
  tesseract/          tesseract.js, WASM core, eng.traineddata
  jszip/  marked/
serve.py              loopback-only static server
```

The engine reads each page's text with positions to infer headings (font-size
ranking), lists, and emphasis (resolved from real font names); walks the PDF
operator list to find raster images and to cluster vector-drawing operations
into diagram regions; rasterizes those regions from a single page render; and
associates nearby "Figure N" captions. Optional OCR runs on extracted images and
on text-less (scanned) pages.

## Limitations

- **Tables** are kept as text lines, not reconstructed into Markdown tables.
- **Caption matching** is positional and works best with conventional
  "Figure N:"/"Table N:" labels.
- **Bold/italic** is best-effort, based on the font the PDF uses.
- **OCR quality** depends on source resolution; it reads text, it does not
  describe imagery.
- **Diagram descriptions** (semantic AI captions) are not generated — see the
  table above.

## Third-party software

Bundled under `vendor/` and used offline. See [`NOTICE.md`](NOTICE.md) for the
full list and licenses (pdf.js — Apache-2.0; tesseract.js & core — Apache-2.0;
JSZip — MIT/GPLv3; marked — MIT).
