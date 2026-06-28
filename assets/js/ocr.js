// ocr.js — fully offline OCR via locally-vendored tesseract.js.
// Everything (the worker script, the WASM core, and the eng language model)
// is loaded from ./vendor/tesseract. Nothing is fetched from a CDN.

const v = (p) => new URL('vendor/' + p, document.baseURI).href;

let _tesseractLoaded = null;
let _worker = null;

// Lazily inject the UMD build so window.Tesseract becomes available. Loaded only
// when the user actually enables OCR, so the rest of the app stays lightweight.
function loadTesseract() {
  if (_tesseractLoaded) return _tesseractLoaded;
  _tesseractLoaded = new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve(window.Tesseract);
    const s = document.createElement('script');
    s.src = v('tesseract/tesseract.min.js');
    s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract failed to initialise'));
    s.onerror = () => reject(new Error('Could not load vendored tesseract.min.js'));
    document.head.appendChild(s);
  });
  return _tesseractLoaded;
}

/**
 * Initialise (once) and return a recognizer function: (Blob) => Promise<string>.
 * @param {(p:number,msg:string)=>void} onProgress
 */
export async function getOcr(onProgress = () => {}) {
  if (_worker) return recognizeWith(_worker);

  const Tesseract = await loadTesseract();
  onProgress(0, 'Loading offline OCR model…');

  _worker = await Tesseract.createWorker('eng', 1 /* LSTM_ONLY */, {
    workerPath: v('tesseract/worker.min.js'),
    corePath: v('tesseract/core'),     // directory; worker appends the core file
    langPath: v('tesseract/lang'),     // directory containing eng.traineddata.gz
    workerBlobURL: false,              // use same-origin worker script directly (CSP: worker-src 'self')
    gzip: true,                        // language data is shipped gzipped
    logger: (m) => {
      if (m && typeof m.progress === 'number') {
        onProgress(m.progress, m.status || 'OCR…');
      }
    },
  });

  return recognizeWith(_worker);
}

function recognizeWith(worker) {
  return async function recognize(blobOrImage) {
    try {
      const { data } = await worker.recognize(blobOrImage);
      return (data && data.text) ? data.text : '';
    } catch (e) {
      console.warn('OCR error:', e);
      return '';
    }
  };
}

export async function terminateOcr() {
  if (_worker) { try { await _worker.terminate(); } catch {} _worker = null; }
}
