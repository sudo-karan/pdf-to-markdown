// preview.js — render Markdown to HTML for the live preview.
// Uses the vendored `marked` global. Output is sanitized (defence-in-depth on
// top of the page CSP, which already blocks inline scripts / event handlers).

/**
 * @param {string} markdown
 * @param {Map<string,string>} imageUrlMap  maps "images/foo.png" -> blob: URL
 * @returns {string} sanitized HTML
 */
export function renderMarkdown(markdown, imageUrlMap = new Map()) {
  if (!window.marked) return '<p class="muted">Preview library unavailable.</p>';

  marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });

  // Pull a leading YAML front-matter block out so marked doesn't mis-render it
  // as a giant setext heading; show it as a small metadata box instead.
  let prefix = '';
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    prefix = `<pre class="frontmatter">${escapeHtml('---\n' + fm[1] + '\n---')}</pre>`;
    markdown = markdown.slice(fm[0].length);
  }

  let html = prefix + window.marked.parse(markdown);
  html = sanitize(html);
  html = rewriteImages(html, imageUrlMap);
  return html;
}

// Replace relative image sources with in-memory blob URLs so the preview can
// display extracted images without writing anything to disk.
function rewriteImages(html, map) {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]*)(")/gi, (m, pre, src, post) => {
    const url = map.get(src) || map.get(src.replace(/^\.\//, ''));
    return url ? pre + url + post : m;
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Allow-list sanitizer (defence-in-depth on top of: (a) the page CSP, which
// blocks inline scripts/handlers and external loads, and (b) source-level
// escaping in converter.js, which strips angle brackets from PDF-derived text).
// Only known-safe tags survive; everything else is dropped or unwrapped, every
// attribute is removed unless explicitly allowed, and URLs must match a safe
// scheme allow-list. Parsed into a detached <template> so nothing executes.
const ALLOWED_TAGS = new Set([
  'a', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
  'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'img', 'details', 'summary', 'span', 'sub', 'sup',
]);
const DROP_WITH_SUBTREE = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'meta', 'base', 'link',
  'form', 'input', 'button', 'svg', 'math', 'template', 'noscript', 'frame', 'frameset',
]);
const ALLOWED_ATTRS = {
  a: ['href', 'title'], img: ['src', 'alt', 'title'],
  td: ['align'], th: ['align'], details: ['open'], ol: ['start'],
};
// relative, anchor, http(s), mailto — plus data:/blob: images for <img> only.
const SAFE_URL = /^(https?:|mailto:|#|\/|\.?\.?\/|[a-z0-9._~%-]+(?:[/?#]|$))/i;

function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const el of [...tpl.content.querySelectorAll('*')]) {
    if (!tpl.content.contains(el)) continue;            // already removed via an ancestor
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      if (DROP_WITH_SUBTREE.has(tag)) el.remove();
      else el.replaceWith(...el.childNodes);            // unwrap unknown-but-harmless tag, keep text
      continue;
    }
    const allowed = ALLOWED_ATTRS[tag] || [];
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (!allowed.includes(name)) { el.removeAttribute(attr.name); continue; }
      if (name === 'href' || name === 'src') {
        const val = attr.value.trim();
        const ok = SAFE_URL.test(val) || (tag === 'img' && /^(data:image\/|blob:)/i.test(val));
        if (!ok) el.removeAttribute(attr.name);
      }
    }
    if (tag === 'a' && el.hasAttribute('href')) el.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  return tpl.innerHTML;
}
