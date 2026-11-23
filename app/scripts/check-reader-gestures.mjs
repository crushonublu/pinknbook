// Run from app/: node scripts/check-reader-gestures.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source=fs.readFileSync('src/mobile/readerGestures.ts','utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {watchReaderGestures}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
let clock=1000;Object.defineProperty(globalThis,'performance',{value:{now:()=>clock},configurable:true});
class Doc extends EventTarget {
 selection={isCollapsed:true}; link=false; frameLeft=0; frameTop=0;
 defaultView={frameElement:{getBoundingClientRect:()=>({left:this.frameLeft,top:this.frameTop})}};
 getSelection(){return this.selection;}
 closest(){return this.link?{}:null;}
}
const doc=new Doc();let turns=[],toggles=0,highlight=false,foliateTouches=0,curl=null,busy=false,dragStarts=0;
watchReaderGestures(doc,{point:(x,y)=>({x:x+doc.frameLeft,y:y+doc.frameTop}),selected:()=>!doc.selection.isCollapsed,bounds:()=>({left:0,width:390}),hitHighlight:()=>highlight,turn:d=>turns.push(d),toggle:()=>toggles++,drag:()=>curl,busy:()=>busy,onDrag:()=>dragStarts++});
for(const type of ['touchstart','touchmove','touchend','touchcancel'])doc.addEventListener(type,()=>foliateTouches++);
const event=(type,props={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,props);doc.dispatchEvent(e);return e;};
const click=x=>event('click',{clientX:x,clientY:150});
const touch=(type,x,y=150,count=1)=>event(type,{touches:type==='touchend'?[]:Array.from({length:count},()=>({clientX:x,clientY:y})),changedTouches:[{clientX:x,clientY:y}]});
let checks=0;const check=(fn,label)=>{fn();checks++;console.log('PASS '+label);};
check(()=>{click(20);click(370);click(195);assert.deepEqual(turns,[-1,1]);assert.equal(toggles,1)},'left/right 28% zones and centre');
check(()=>{doc.frameLeft=-390;click(585);assert.equal(toggles,2);doc.frameLeft=0},'tap coordinates include paginated iframe offset');
check(()=>{doc.link=true;click(20);doc.link=false;highlight=true;click(370);highlight=false;assert.equal(turns.length,2)},'links, footnotes and highlights excluded');
check(()=>{doc.selection={isCollapsed:false};click(195);assert.equal(toggles,2);doc.selection={isCollapsed:true}},'live selection blocks navigation');
check(()=>{touch('touchstart',195);doc.selection={isCollapsed:false};event('selectionchange');doc.selection={isCollapsed:true};touch('touchend',195);click(195);assert.equal(toggles,2);clock+=800},'tap ending a selection is suppressed');
check(()=>{touch('touchstart',320);const m=touch('touchmove',180);assert(m.defaultPrevented);touch('touchend',80);click(80);assert.deepEqual(turns,[-1,1,1]);clock+=800},'horizontal swipe turns once and suppresses synthetic click');
check(()=>{touch('touchstart',60);touch('touchmove',180);touch('touchend',320);assert.equal(turns.at(-1),-1);assert.equal(turns.length,4);clock+=800},'reverse swipe turns back once');
check(()=>{touch('touchstart',195,100);touch('touchmove',210,400);touch('touchend',210,500);click(210);assert.equal(turns.length,4);assert.equal(toggles,2);clock+=800},'vertical gesture does not turn or toggle');
check(()=>{touch('touchstart',300);clock+=600;touch('touchmove',200);touch('touchend',100);click(100);assert.equal(turns.length,4);clock+=800},'long press does not navigate');
check(()=>{touch('touchstart',300);touch('touchstart',300,150,2);touch('touchend',100);assert.equal(turns.length,4);clock+=800},'multitouch ignored');
check(()=>{touch('touchstart',300);touch('touchcancel',100);click(100);assert.equal(turns.length,4);clock+=800},'cancelled gesture does not navigate');
check(()=>{assert.equal(foliateTouches,0)},'foliate touch handler cannot double-turn or prevent selection');
check(()=>{touch('touchstart',300);clock+=100;touch('touchmove',260);clock+=600;touch('touchmove',120);touch('touchend',80);assert.equal(turns.length,5);assert.equal(turns.at(-1),1);clock+=800},'slow swipe that begins promptly still turns one page');
const calls=[];
curl={beginDrag:(...args)=>{calls.push(['begin',...args.slice(0,3)]);return true;},moveDrag:(...args)=>calls.push(['move',...args]),endDrag:cancel=>calls.push(['end',cancel])};
check(()=>{doc.frameLeft=-390;doc.frameTop=40;touch('touchstart',720);touch('touchmove',690);clock+=2000;touch('touchmove',660);touch('touchend',660);click(660);assert.deepEqual(calls,[['begin',1,330,190],['move',300,190],['move',270,190],['end',false]]);assert.equal(turns.length,5);assert.equal(dragStarts,1);doc.frameLeft=0;doc.frameTop=0;clock+=800},'curl starts at original main-window point, follows every move, accepts a long hold and never plain-turns');
check(()=>{calls.length=0;touch('touchstart',60);touch('touchmove',90);touch('touchend',90);assert.deepEqual(calls,[['begin',-1,60,150],['move',90,150],['end',false]]);assert.equal(turns.length,5);clock+=800},'left-half reverse curl consumes even a short drag');
check(()=>{calls.length=0;touch('touchstart',320);touch('touchmove',280);touch('touchcancel',280);click(20);assert.equal(calls.at(-1)[1],true);assert.equal(turns.length,5);clock+=800},'curl touchcancel cancels fold and suppresses click');
check(()=>{calls.length=0;touch('touchstart',320);touch('touchmove',280);touch('touchstart',280,150,2);touch('touchend',80);assert.equal(calls.filter(c=>c[0]==='end').length,1);assert.deepEqual(calls.at(-1),['end',true]);assert.equal(turns.length,5);clock+=800},'second finger cancels active curl exactly once');
check(()=>{calls.length=0;touch('touchstart',320);touch('touchmove',280);doc.selection.isCollapsed=false;event('selectionchange');doc.selection.isCollapsed=true;touch('touchend',80);assert.deepEqual(calls.at(-1),['end',true]);assert.equal(turns.length,5);clock+=800},'selection appearing during drag cancels and keeps selection gestures native');
check(()=>{calls.length=0;touch('touchstart',320);clock+=600;touch('touchmove',100);touch('touchend',100);assert.equal(calls.length,0);assert.equal(turns.length,5);clock+=800},'curl does not claim a long press');
check(()=>{calls.length=0;busy=true;touch('touchstart',320);touch('touchmove',100);touch('touchend',100);assert.equal(calls.length,0);assert.equal(turns.length,5);clock+=800;touch('touchstart',370);touch('touchend',370);click(370);assert.equal(turns.length,6);assert.equal(turns.at(-1),1);clock+=800;const before=toggles;touch('touchstart',195);touch('touchend',195);click(195);assert.equal(toggles,before);busy=false;clock+=800},'busy curl ignores new drags and centre taps but queues one edge tap');
check(()=>{calls.length=0;curl.beginDrag=()=>false;touch('touchstart',320);touch('touchmove',100);touch('touchend',100);assert.equal(calls.length,0);assert.equal(turns.length,6);clock+=800},'refused drag cannot fall through to plain navigation');
check(()=>{calls.length=0;touch('touchstart',300,150,2);touch('touchend',195);click(195);assert.equal(calls.length,0);assert.equal(turns.length,6);clock+=800},'gesture beginning with two fingers suppresses synthetic navigation');
// The same recognizer on a plain host EventTarget: no iframe coordinate offset.
const host=new EventTarget(), selectionEvents=new EventTarget();
let hostTurns=[],hostToggles=0,hostSelected=false,hostBusy=false,hostCurl=null;
const hostCalls=[];
const hostDrag={beginDrag:(...a)=>{hostCalls.push(['begin',...a]);return true;},moveDrag:(...a)=>hostCalls.push(['move',...a]),endDrag:c=>hostCalls.push(['end',c])};
const hostOptions={bounds:()=>({left:5,top:30,width:411,height:700}),point:(x,y)=>({x,y}),selected:()=>hostSelected,selectionTarget:selectionEvents,
 accept:e=>!e.composedPath().some(node=>node.localName==='iframe'),
 turn:d=>hostTurns.push(d),toggle:()=>hostToggles++,drag:()=>hostCurl,busy:()=>hostBusy};
let stopHost=watchReaderGestures(host,hostOptions);
const hostEvent=(type,props={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,props);host.dispatchEvent(e);return e;};
const hostClick=(x,y=150)=>hostEvent('click',{clientX:x,clientY:y});
const hostTouch=(type,x,y=150,count=1)=>hostEvent(type,{touches:type==='touchend'?[]:Array.from({length:count},()=>({clientX:x,clientY:y})),changedTouches:[{clientX:x,clientY:y}]});
const hostSwipe=(from,to,y=150)=>{hostTouch('touchstart',from,y);hostTouch('touchmove',to,y);hostTouch('touchend',to,y);hostClick(to,y);clock+=800;};
check(()=>{hostClick(415);hostClick(6);hostClick(210,31);hostClick(210,729);assert.deepEqual(hostTurns,[1,-1]);assert.equal(hostToggles,2);},'host right/left gutter taps and top/bottom centre margins use host bounds');
check(()=>{for(const inset of [0,6,12]){hostSwipe(415-inset,155);hostSwipe(5+inset,270);}assert.deepEqual(hostTurns.slice(2),[1,-1,1,-1,1,-1]);},'plain host swipes starting within 0?12 px of either phone edge turn once');
check(()=>{hostCurl=hostDrag;const time=clock;hostSwipe(415,155,31);assert.deepEqual(hostCalls,[['begin',1,415,31,time],['move',155,31],['end',false]]);assert.equal(hostTurns.length,8);hostCalls.length=0;hostSwipe(5,270,729);assert.equal(hostCalls[0][1],-1);assert.deepEqual(hostCalls[1],['move',270,729]);assert.equal(hostTurns.length,8);},'host Curl uses unshifted main-window coordinates at side, top and bottom margins');
check(()=>{hostCalls.length=0;hostSelected=true;hostSwipe(415,155);hostClick(415);hostSelected=false;assert.equal(hostCalls.length,0);assert.equal(hostTurns.length,8);},'existing section selection blocks host taps and drags');
check(()=>{hostTouch('touchstart',415);hostTouch('touchmove',350);hostSelected=true;selectionEvents.dispatchEvent(new Event('selectionchange'));hostSelected=false;hostTouch('touchend',155);hostClick(155);assert.deepEqual(hostCalls.at(-1),['end',true]);assert.equal(hostTurns.length,8);clock+=800;},'selection cancels host Curl and suppresses following click');
check(()=>{hostCalls.length=0;hostTouch('touchstart',415);clock+=600;hostTouch('touchmove',155);hostTouch('touchend',155);hostClick(155);assert.equal(hostCalls.length,0);assert.equal(hostTurns.length,8);clock+=800;},'host long press never navigates');
check(()=>{hostTouch('touchstart',415,100);hostTouch('touchmove',410,400);hostTouch('touchend',410,500);hostClick(410);assert.equal(hostCalls.length,0);assert.equal(hostTurns.length,8);clock+=800;},'host vertical gesture never turns or starts Curl');
check(()=>{for(const ending of ['touchcancel','multitouch']){hostCalls.length=0;hostTouch('touchstart',415);hostTouch('touchmove',350);if(ending==='multitouch')hostTouch('touchstart',350,150,2);else hostTouch('touchcancel',350);hostTouch('touchend',155);hostClick(155);assert.equal(hostCalls.filter(c=>c[0]==='end').length,1);assert.deepEqual(hostCalls.at(-1),['end',true]);assert.equal(hostTurns.length,8);clock+=800;}},'host multitouch and cancellation end Curl exactly once');
check(()=>{hostCalls.length=0;hostBusy=true;hostSwipe(415,155);assert.equal(hostCalls.length,0);assert.equal(hostTurns.length,8);hostTouch('touchstart',415);hostTouch('touchend',415);hostClick(415);assert.deepEqual(hostTurns.slice(8),[1]);clock+=800;hostTouch('touchstart',210);hostTouch('touchend',210);hostClick(210);assert.equal(hostToggles,2);hostBusy=false;clock+=800;},'host busy Curl ignores drags and queues exactly one gutter tap');
check(()=>{const before=hostTurns.length;for(const type of ['touchstart','touchmove','touchend','click']){const e=hostEvent(type,{composedPath:()=>[{localName:'iframe'},host],touches:[{clientX:415,clientY:150}],changedTouches:[{clientX:155,clientY:150}],clientX:415,clientY:150});assert.equal(e.defaultPrevented,false);}assert.equal(hostTurns.length,before);assert.equal(hostCalls.length,0);},'host ignores iframe-element paths, including shadow-retargeted events');
check(()=>{hostCurl=null;const before=hostTurns.length;click(370);assert.equal(hostTurns.length,before);assert.equal(turns.length,7);},'section document dispatch only reaches its own recognizer');
check(()=>{hostCurl=hostDrag;hostTouch('touchstart',415);hostTouch('touchmove',350);stopHost();assert.deepEqual(hostCalls.at(-1),['end',true]);const count=hostCalls.length;hostTouch('touchend',155);hostClick(415);assert.equal(hostCalls.length,count);assert.equal(hostTurns.length,9);stopHost=watchReaderGestures(host,hostOptions);hostCurl=null;hostClick(415);assert.equal(hostTurns.length,10);stopHost();},'host cleanup cancels active drag, removes listeners and allows one clean reattachment');
console.log(checks+' gesture checks passed');

// Real curl lifecycle with DOM/bitmap adapters; rasterisation needs a WebView.
const curlSource=fs.readFileSync('src/curl/PageCurl.ts','utf8');
const curlJs=ts.transpileModule(curlSource.replace(/^import .*;$/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const backendSource=fs.readFileSync('src/curl/webgl.ts','utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');
const backendJs=ts.transpileModule(backendSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const injected=`const mirror=p=>({x:-p.x,y:p.y}); const solveCurl=()=>({}); const solveCurlInto=()=>({}); const drawCurl=()=>{};
const pageTexture=()=>({}); const backTexture=()=>({}); const snapshotPage=(...a)=>globalThis.testSnapshot(...a);`;
const {PageCurl}=await import('data:text/javascript;base64,'+Buffer.from(injected+backendJs+curlJs).toString('base64'));
class El extends EventTarget {
 style={}; children=[]; width=0; height=0;
 append(el){this.children.push(el);} remove(){} setAttribute(){}
 getContext(){return {setTransform(){},clearRect(){},drawImage(){}};}
 getBoundingClientRect(){return {left:0,top:0,width:390,height:700};}
}
let reduce=false;
globalThis.document={createElement:()=>new El()};
globalThis.matchMedia=()=>({get matches(){return reduce;}});
globalThis.ResizeObserver=class {observe(){} disconnect(){}};
let timerId=0;const timers=new Map();
globalThis.window={devicePixelRatio:3.5,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),getComputedStyle:()=>({backgroundColor:'#fff'})};
globalThis.requestAnimationFrame=fn=>{queueMicrotask(()=>fn(clock));return 1;};
globalThis.cancelAnimationFrame=()=>{};
globalThis.testSnapshot=async()=>new El();
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const makeCurl=(options={zones:false,readyOnly:true})=>{
 const frameEl=new El();
 const doc={body:{},documentElement:{style:{getPropertyValue:name=>name==='column-width'?'390':'0'}},defaultView:{frameElement:frameEl,getComputedStyle:()=>({writingMode:'horizontal-tb',backgroundColor:'#fff'})}};
 const view=new EventTarget();view.book={};view.renderer={tagName:'FOLIATE-PAGINATOR',size:390,pages:12,page:4,start:390,getAttribute:()=>null,getContents:()=>[{doc,index:0}]};
 const nav=[];view.next=async()=>{nav.push(1);view.renderer.page++;};view.prev=async()=>{nav.push(-1);view.renderer.page--;};
 const host=new El();const effect=new PageCurl(host,view,options);effect.animate=async()=>{};
 return {effect,view,host,nav,doc};
};
let curlChecks=0;const curlCheck=async(fn,label)=>{await fn();curlChecks++;console.log('PASS '+label);};
const warm=async c=>{const L=c.effect.measure();await c.effect.snap(L,L.page);await c.effect.snap(L,L.page+1);await c.effect.snap(L,L.page-1);};
await curlCheck(async()=>{const desktop=makeCurl({});assert.equal(desktop.host.children.filter(e=>e.className?.startsWith('curl-zone')).length,2);desktop.effect.destroy();const mobile=makeCurl();assert.equal(mobile.host.children.length,1);assert.equal(mobile.effect.measure().dpr,2);mobile.effect.destroy();},'desktop retains edge strips; mobile has no strips and caps DPR at 2');
await curlCheck(async()=>{const c=makeCurl();await warm(c);c.effect.turn(1);await flush();assert.deepEqual(c.nav,[1]);assert.equal(c.effect.running,false);c.effect.destroy();},'warm automatic curl commits exactly once');
await curlCheck(async()=>{const c=makeCurl();await warm(c);assert(c.effect.beginDrag(1,370,500));clock+=500;c.effect.moveDrag(320,500);await flush();clock+=200;c.effect.endDrag(false);c.effect.endDrag(false);await flush();assert.deepEqual(c.nav,[]);assert.equal(c.effect.running,false);c.effect.destroy();},'slow forward drag before middle drops back; repeated end is harmless');
await curlCheck(async()=>{const c=makeCurl();await warm(c);c.effect.beginDrag(1,370,500);clock+=500;c.effect.moveDrag(100,500);await flush();clock+=200;c.effect.endDrag(false);await flush();assert.deepEqual(c.nav,[1]);c.effect.destroy();},'forward drag beyond middle commits once');
await curlCheck(async()=>{for(const dir of [1,-1]){const c=makeCurl();await warm(c);c.effect.beginDrag(dir,dir===1?370:20,500);clock+=20;c.effect.moveDrag(dir===1?330:60,500);await flush();c.effect.endDrag(false);await flush();assert.deepEqual(c.nav,[dir]);c.effect.destroy();}},'short flick commits forward and reverse curls');
await curlCheck(async()=>{const c=makeCurl();await warm(c);c.effect.beginDrag(-1,20,500);clock+=500;c.effect.moveDrag(50,500);await flush();clock+=200;c.effect.endDrag(false);await flush();assert.deepEqual(c.nav,[]);c.effect.destroy();},'slow reverse curl near left edge drops back');
await curlCheck(async()=>{const c=makeCurl();await warm(c);c.effect.beginDrag(-1,20,500);clock+=500;c.effect.moveDrag(300,500);await flush();clock+=200;c.effect.endDrag(false);await flush();assert.deepEqual(c.nav,[-1]);c.effect.destroy();},'reverse curl across page commits previous page');
await curlCheck(async()=>{const c=makeCurl();await warm(c);c.effect.beginDrag(1,370,500);c.effect.moveDrag(50,500);await flush();c.effect.endDrag(true);await flush();assert.deepEqual(c.nav,[]);c.effect.destroy();},'cancelled prepared curl never commits');
await curlCheck(async()=>{for(const setup of [c=>{c.view.book.dir='rtl';},c=>{c.view.renderer.scrolled=true;},c=>{c.doc.defaultView.getComputedStyle=()=>({writingMode:'vertical-rl'});},c=>{c.view.renderer.pages=2;},()=>{reduce=true;}]){const c=makeCurl();setup(c);c.effect.turn(1);await flush();assert.deepEqual(c.nav,[1]);c.effect.destroy();reduce=false;}},'RTL, scrolling, vertical writing, short section and reduced motion turn plainly once');
await curlCheck(async()=>{const c=makeCurl();globalThis.testSnapshot=()=>new Promise(()=>{});const L=c.effect.measure();void c.effect.snap(L,L.page);c.effect.turn(1);await flush();assert.deepEqual(c.nav,[1]);assert.equal(c.effect.canvas.style.display,'none');c.effect.destroy();globalThis.testSnapshot=async()=>new El();},'pending snapshot never stalls or covers first mobile tap');
await curlCheck(async()=>{const c=makeCurl();globalThis.testSnapshot=async()=>{throw Error('snapshot timeout');};await c.effect.snap(c.effect.measure(),4).catch(()=>{});c.effect.beginDrag(1,370,500);c.effect.moveDrag(270,500);c.effect.endDrag(false);await flush();assert.deepEqual(c.nav,[1]);c.effect.destroy();globalThis.testSnapshot=async()=>new El();},'failed snapshot drag falls back once');
await curlCheck(async()=>{const c=makeCurl();await warm(c);c.effect.turn(1);c.effect.turn(1);await flush();assert.deepEqual(c.nav,[1,1]);c.effect.invalidate();assert.equal(c.effect.readySnapshots.size,0);c.effect.destroy();},'queued taps commit once each and invalidation clears bitmaps');
await curlCheck(async()=>{const c=makeCurl();c.doc.documentElement.style.getPropertyValue=name=>name==='column-width'?'195':'0';assert.equal(c.effect.measure().spread,true);await warm(c);c.effect.beginDrag(-1,20,500);clock+=500;c.effect.moveDrag(160,500);await flush();clock+=200;c.effect.endDrag(false);await flush();assert.deepEqual(c.nav,[-1]);c.effect.destroy();},'landscape spread uses mirrored left-sheet drag');
console.log(curlChecks+' curl checks passed');

// Preference loading: only Android gets the new default; saved values win.
const prefSource=fs.readFileSync('src/readerPrefs.ts','utf8').replace(/^import .*;$/gm,'');
for(const android of [false,true]){
 const prefJs=ts.transpileModule(`const isAndroid=${android}; const BOOK_FONT='serif'; const FONT_FACE_CSS='';`+prefSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 const {loadPrefs}=await import('data:text/javascript;base64,'+Buffer.from(prefJs).toString('base64'));
 let saved=null;globalThis.localStorage={getItem:key=>key===(android?'androidReaderPrefs':'readerPrefs')?saved:null};
 assert.equal(loadPrefs().mobileMotion,android?'curl':undefined);
 for(const mode of ['curl','slide','none']){saved=JSON.stringify({mobileMotion:mode});assert.equal(loadPrefs().mobileMotion,mode);}
}
console.log('PASS Android curl default, saved motion values, and unchanged desktop default');

// Exercise the vendored selection listeners and scroll guard with DOM adapters.
// Strip private-field syntax only so these actual methods can use a fake host.
const paginatorSource = fs.readFileSync('public/foliate/paginator.js', 'utf8');
const fields = source => source.replace(/this\.#/g, 'this.');
const listeners = fields(paginatorSource.slice(
  paginatorSource.indexOf('        const checkPointerSelection ='),
  paginatorSource.indexOf('        this.#mediaQueryListener =')));
const restore = fields(paginatorSource.slice(
  paginatorSource.indexOf('    #restoreSelectionScroll() {'),
  paginatorSource.indexOf('    attributeChangedCallback(')));
const adapter = new Function(`return class { ${restore.replace('#restoreSelectionScroll', 'restoreSelectionScroll')} }`)();
for (const android of [false, true]) {
  const doc = new EventTarget();
  let forward = true, turns = 0, anchors = 0, pending;
  const selection = { rangeCount: 1, isCollapsed: false, type: 'Range',
    getRangeAt: () => ({ compareBoundaryPoints: () => forward ? 1 : -1,
      cloneRange: () => ({ collapse() {} }) }) };
  doc.getSelection = () => selection;
  const host = Object.assign(new adapter(), {
    hasAttribute: () => android, scrolled: false, lastVisibleRange: {},
    view: { document: doc }, container: { scrollLeft: 390 },
    scrollBounds: [390], scrollProp: 'scrollLeft',
    next: () => turns++, prev: () => turns--, scrollToAnchor: () => anchors++,
    addEventListener: (_, listener) => listener({ detail: { doc } }),
  });
  new Function('debounce', 'selectionIsBackward', 'Range', listeners).call(
    host, fn => (...args) => { pending = () => fn(...args); }, () => !forward,
    { START_TO_START: 0, END_TO_END: 2 });
  doc.dispatchEvent(new Event('pointerdown'));
  doc.dispatchEvent(new Event('selectionchange'));
  pending?.();
  assert.equal(turns, android ? 0 : 1);
  forward = false;
  doc.dispatchEvent(new Event('selectionchange'));
  pending?.();
  assert.equal(turns, 0);
  doc.dispatchEvent(new Event('pointercancel'));
  doc.dispatchEvent(new Event('keydown'));
  doc.dispatchEvent(new Event('pointerup'));
  doc.dispatchEvent(new Event('selectionchange'));
  assert.equal(anchors, android ? 0 : 1);
  for (const offset of [390, -390]) {
    host.scrollBounds = [offset]; host.container.scrollLeft = offset + 50;
    assert.equal(host.restoreSelectionScroll(), android);
    assert.equal(host.container.scrollLeft, android ? offset : offset + 50);
  }
  selection.isCollapsed = true;
  assert.equal(host.restoreSelectionScroll(), false);
  selection.isCollapsed = false; host.scrolled = true;
  assert.equal(host.restoreSelectionScroll(), false);
}
console.log('PASS Android selection cannot navigate or autoscroll; desktop pointer/keyboard selection retained');

await curlCheck(async()=>{const c=makeCurl();await warm(c);c.effect.beginDrag(1,370,500,clock-40);c.effect.moveDrag(330,500);await flush();c.effect.endDrag(false);await flush();assert.deepEqual(c.nav,[1]);c.effect.destroy();},'first recognised move uses original touch time for a one-move flick');
