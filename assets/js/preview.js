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

// Minimal allow-list-ish sanitizer: strip <script>/<style>/<iframe>, all on*
// handlers, and javascript:/vbscript: URLs. Renders into a detached template so
// nothing executes during cleaning.
function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
  const kill = [];
  let node = walker.nextNode();
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      kill.push(node);
    } else {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim();
        if (name.startsWith('on')) node.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*(javascript|vbscript|data:text\/html)/i.test(val)) {
          node.removeAttribute(attr.name);
        }
      }
    }
    node = walker.nextNode();
  }
  kill.forEach(n => n.remove());
  return tpl.innerHTML;
}
