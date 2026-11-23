// Run from app/: node scripts/check-touch-selection.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";

let now = 0, next = 0;
const timers = new Map();
const storage = new Map();
function load(path, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    setTimeout: (fn, delay) => { timers.set(++next, { fn, time: now + delay }); return next; },
    clearTimeout: (id) => timers.delete(id),
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    ...globals,
  });
  return exports;
}
function advance(ms) {
  now += ms;
  for (const [id, timer] of timers) if (timer.time <= now) { timers.delete(id); timer.fn(); }
}
class Doc extends EventTarget {
  defaultView = {};
  documentElement = { classList: { add() {} } };
  head = { append() {} };
  createElement() { return { remove() {} }; }
}
const { watchTouchSelection } = load("src/mobile/selection.ts");
const doc = new Doc();
let updates = 0;
const cleanup = watchTouchSelection(doc, () => updates++);
const fire = (type) => { const event = new Event(type, { cancelable: true }); doc.dispatchEvent(event); return event; };
fire("touchstart"); fire("selectionchange"); advance(400);
assert.equal(updates, 0, "first long press waits for finger release");
fire("touchend"); advance(249); assert.equal(updates, 0);
advance(1); assert.equal(updates, 1, "first word updates after release and stability");
fire("touchstart"); fire("selectionchange"); advance(100);
fire("selectionchange"); advance(300); assert.equal(updates, 1);
fire("touchend"); advance(250); assert.equal(updates, 2, "handle drag updates the request");
fire("selectionchange"); advance(200); fire("selectionchange"); advance(200);
assert.equal(updates, 2); advance(50); assert.equal(updates, 3, "changes debounce until stable");
fire("touchstart"); fire("touchcancel"); fire("selectionchange"); advance(250);
assert.equal(updates, 4, "native takeover can finish after touchcancel");
assert.equal(fire("contextmenu").defaultPrevented, true, "context menu suppressed");
assert.equal(fire("touchstart").defaultPrevented, false, "native selection is not prevented");
fire("touchend"); cleanup(); advance(300); fire("selectionchange"); advance(300);
assert.equal(updates, 4, "unmount cancels timers and removes listeners");

const styles = load("src/mobile/annotationStyle.ts");
const annotation = { id: 1, cfi: "epubcfi(/6/2)", color: "blue" };
styles.saveMobileAnnotationStyle(annotation, "green");
assert.equal(styles.mobileAnnotationStyle(annotation), "green");
assert.equal(styles.mobileBaseColor("green"), "yellow");
styles.saveMobileAnnotationStyle(annotation, "underline");
assert.equal(styles.mobileAnnotationStyle(annotation), "underline");
assert.equal(styles.mobileBaseColor("underline"), "yellow");
assert.equal(styles.mobileAnnotationStyle({ ...annotation, cfi: "different" }), "blue", "style cannot leak to another annotation");
styles.saveMobileAnnotationStyle(annotation, "pink");
assert.equal(styles.mobileAnnotationStyle(annotation), "blue", "standard colour clears local override");

const element = (name) => ({ name, attrs: {}, style: {}, children: [], setAttribute(key, value) { this.attrs[key] = value; }, append(child) { this.children.push(child); } });
const { drawHighlight } = load("src/annotate.ts", { document: { createElementNS: (_, name) => element(name) } });
const rects = [{ left: 10, top: 20, bottom: 40, width: 80, height: 20 }];
const normal = drawHighlight(rects, { color: "yellow", note: false, dark: false });
const underline = drawHighlight(rects, { color: "yellow", note: false, dark: false, underline: true });
assert.equal(normal.children[0].children[0].attrs.height, "20", "desktop highlight retains full height");
assert.equal(underline.children[0].children[0].attrs.y, "38");
assert.equal(underline.children[0].children[0].attrs.height, "2", "underline covers only the baseline");
console.log("Touch selection, local styles, and annotation drawing checks passed");
