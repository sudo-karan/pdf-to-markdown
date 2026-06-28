# Tests

End-to-end test that serves the app locally, converts a fixture PDF in headless
Chromium **under the real Content-Security-Policy**, and asserts both:

- **Correctness** — headings, lists, bold/italic, raster image + vector diagram
  extraction, caption association, front matter.
- **Air-gap** — **zero** off-host network requests are made during conversion.

## Prerequisites

- Node.js 18+
- Python 3 (for the bundled `serve.py`)
- A Chromium/Chrome binary, referenced via `CHROMIUM_PATH`
- `playwright-core` (used only to drive/headless-render — it does **not** download
  a browser here):

```bash
cd tests
npm install            # installs playwright-core (devDependency)
```

## Run

```bash
# from the tests/ folder
CHROMIUM_PATH=/path/to/chrome npm run fixture   # generates tests/fixture.pdf
CHROMIUM_PATH=/path/to/chrome npm test          # serves the app + runs assertions
```

`fixture.pdf` is a generated artifact (git-ignored). Regenerate it any time with
`npm run fixture`. The test prints a PASS/FAIL line per assertion and exits
non-zero if anything fails.
