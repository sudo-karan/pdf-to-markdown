# Third-party software

This application bundles the following open-source libraries under `vendor/` so
that it runs fully offline. Each is used unmodified. License texts are included
alongside the code in each vendored folder.

| Library | Version | License | Vendored at |
|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 4.7.76 | Apache-2.0 | `vendor/pdfjs/` |
| [tesseract.js](https://github.com/naptha/tesseract.js) | 5.1.1 | Apache-2.0 | `vendor/tesseract/` |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) (WASM) | 5.1.1 | Apache-2.0 | `vendor/tesseract/core/` |
| Tesseract English model (`eng.traineddata`) | 4.0.0 | Apache-2.0 | `vendor/tesseract/lang/` |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT or GPLv3 | `vendor/jszip/` |
| [marked](https://github.com/markedjs/marked) | 12.0.2 | MIT | `vendor/marked/` |

pdf.js also bundles its CMap tables (`vendor/pdfjs/cmaps/`, BSD) and standard
font substitutes (`vendor/pdfjs/standard_fonts/`, Foxit / Liberation licenses,
included in that folder).

No other code or data is fetched at runtime. The app makes no network requests.
