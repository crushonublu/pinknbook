import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Minimal DOM fixture: run the actual TS loader, including sanitization and
// section fallback, without adding a browser/DOM dependency to the app.
class Node {
  static TEXT_NODE = 3;
  static ELEMENT_NODE = 1;
  constructor(tag = '', text = '', attrs = {}) {
    this.localName = tag;
    this.nodeType = tag === '#text' ? 3 : tag === '#fragment' ? 11 : 1;
    this.text = text;
    this.attrs = attrs;
    this.childNodes = [];
  }
  get textContent() { return this.text + this.childNodes.map(n => n.textContent).join(''); }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstElementChild() { return this.children[0]; }
  get nextElementSibling() { const siblings = this.parentElement?.children ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
  appendChild(node) { node.parentElement = this; node.ownerDocument = this.ownerDocument; this.childNodes.push(node); return node; }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  getAttributeNS(_, key) { return this.attrs[`epub:${key}`] ?? null; }
  contains(node) { return node === this || this.childNodes.some(n => n.contains(node)); }
  matches(selector) { return selector.split(',').some(s => s.trim() === this.localName); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  compareDocumentPosition(node) { const all = this.ownerDocument.body.querySelectorAll('p,div,a,sup,span,aside'); return all.indexOf(node) > all.indexOf(this) ? 4 : 2; }
}
function doc() {
  const d = {
    createElement(tag) { const n = new Node(tag); n.ownerDocument = d; return n; },
    createTextNode(text) { const n = new Node('#text', text); n.ownerDocument = d; return n; },
    createDocumentFragment() { return new Node('#fragment'); },
    querySelectorAll(selector) { return d.body.querySelectorAll(selector); },
  };
  d.body = d.createElement('body');
  return d;
}
const output = doc();
function compile(file, imports = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  vm.runInNewContext(js, { exports, require: name => imports[name] ?? {}, document: output, Node });
  return exports;
}
const fallback = compile('../src/footnoteFallback.ts');
const { loadFootnote, isNoteRef } = compile('../src/Footnote.tsx', { './footnoteFallback': fallback });
for (const [text, marker, expected] of [
  ['2* Mẫu Anh, bằng 0,4 ha.', '2*', true],
  ['↩ 3 Text', '3', true], ['* Text', '*', true], ['[3] Text', '[3]', true],
  ['20 Text', '2', false], ['2* Text', '2', false], ['30 Text', '3', false],
  ['Chapter 3', '3', false], ['', '', false],
]) assert.equal(fallback.startsWithNoteMarker(text, marker), expected, `${marker}: ${text}`);

function fixture(marker = '2*') {
  const d = doc();
  const add = (tag, text, parent = d.body, attrs) => {
    const n = d.createElement(tag); n.attrs = attrs ?? {};
    parent.appendChild(n);
    if (text) n.appendChild(d.createTextNode(text));
    return n;
  };
  const earlier = add('p', `${marker} earlier note`);
  const paragraph = add('p', '');
  const ref = add('a', marker, paragraph, { href: 'XXXXXXXXXXXXXXXXXX', 'epub:type': 'noteref' });
  add('div', `${marker} inside reference paragraph`, paragraph);
  const note = add('p', `${marker} Mẫu Anh, bằng 0,4 ha.`);
  return { d, ref, note, earlier, add };
}
let f = fixture();
assert.equal(isNoteRef(f.ref), true);
assert.equal(fallback.findNoteByMarker(f.d, f.ref, true), f.note);
const book = { sections: [{ createDocument: async () => f.d }], resolveHref: async () => ({ index: 0 }) };
assert.match((await loadFootnote({ book }, 0, f.ref)).textContent, /Mẫu Anh/);
book.resolveHref = async () => { throw Error('broken placeholder'); };
assert.match((await loadFootnote({ book }, 0, f.ref)).textContent, /Mẫu Anh/);

// Following sections, rather than the earlier same-section note.
f.note.parentElement.childNodes = f.note.parentElement.childNodes.filter(n => n !== f.note);
const next = fixture();
book.sections.push({ createDocument: async () => next.d });
assert.match((await loadFootnote({ book }, 0, f.ref)).textContent, /earlier note/);

// An ordinary EPUB anchor keeps working, including safe inline formatting.
f = fixture('3');
f.add('b', ' bold', f.note);
f.add('script', 'unsafe', f.note);
book.sections = [{ createDocument: async () => f.d }];
book.resolveHref = async () => ({ index: 0, anchor: () => f.note });
const content = await loadFootnote({ book }, 0, f.ref);
assert.match(content.textContent, /bold/);
assert.ok(!content.textContent.includes('unsafe'));
assert.ok(content.querySelector('b'));
book.isExternal = () => true;
assert.equal(await loadFootnote({ book }, 0, f.ref), null);
console.log('Footnotes: marker boundaries, reading order, paragraph exclusion, broken/index-only hrefs, following sections, EPUB anchors and sanitization passed.');

// Exercise KF8's actual resolver with two fragments, a base-32 offset, and
// multibyte UTF-8 before the target. The second insertion shifts its position.
const mobiSource = fs.readFileSync(new URL('../public/foliate/mobi.js', import.meta.url), 'utf8');
const begin = mobiSource.indexOf('    async resolveHref(href) {');
const end = mobiSource.indexOf('    splitTOCHref(href)', begin);
const method = mobiSource.slice(begin, end).replaceAll('this.#', 'this._');
const resolver = vm.runInNewContext(`({${method}}).resolveHref`, {
  parsePosURI: href => {
    const [, fid, off] = href.match(/kindle:pos:fid:(\w+):off:(\w+)/);
    return { fid: parseInt(fid, 32), off: parseInt(off, 32) };
  },
  getFragmentSelector: () => undefined,
  concatTypedArray3: (...arrays) => Uint8Array.from(arrays.flatMap(a => [...a])),
});
const encode = text => new TextEncoder().encode(text);
const skeleton = encode('<html><body></body></html>');
const target = encode('<p>Tiếng Việt 3* Note text</p>');
const preceding = encode('<p>Earlier text</p>');
const raw = Uint8Array.from([...skeleton, ...target, ...preceding]);
const offset = encode('<p>Tiếng Việt ').length;
const markedParent = { children: [], parentElement: null };
const markedBody = { children: [{}, markedParent], parentElement: null };
const markedRoot = { children: [markedBody] };
markedBody.parentElement = markedRoot;
markedParent.parentElement = markedBody;
const targetElement = {};
const originalDoc = { documentElement: { children: [{ children: [{}, targetElement] }] } };
const fakeKF8 = {
  _fragmentSelectors: new Map(), _type: 'application/xhtml+xml',
  _sections: [{ skel: { offset: 0, length: skeleton.length }, frags: [
    { index: 5, offset: 0, length: target.length, insertOffset: 12 },
    { index: 6, offset: target.length, length: preceding.length, insertOffset: 12 },
  ] }],
  getIndexByFID: fid => fid === 5 ? 0 : -1,
  loadRaw: async (start, stop) => raw.slice(start, stop),
  mobi: { decode: bytes => new TextDecoder().decode(bytes) },
  parser: { parseFromString: text => {
    assert.ok(text.includes('Tiếng Việt <span data-pntome-note-position="1"></span>3* Note text'));
    assert.ok(text.indexOf('Earlier text') < text.indexOf('Tiếng Việt'));
    return { querySelector: () => ({ parentElement: markedParent, remove() {} }) };
  } },
};
const uri = `kindle:pos:fid:0005:off:${offset.toString(32).padStart(10, '0')}`;
const resolved = await resolver.call(fakeKF8, uri);
assert.equal(resolved.index, 0);
assert.equal(resolved.anchor(originalDoc), targetElement);
assert.equal(await resolver.call(fakeKF8, 'kindle:pos:fid:0099:off:0000000000'), undefined);
console.log('KF8: base-32 byte offset, multibyte text, shifted fragment insertion and element anchor passed.');
