/* pntome site: theme, language, the bookcase, feature tabs and three demos. No dependencies. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const root = document.documentElement;
  let lang = store.get("pntome-site-lang") === "en" ? "en" : "vi";
  let feature = "library";
  let tryPanel = "dict";

  // ---------------------------------------------------------------- Theme
  const shotSrc = (name) => (root.dataset.theme === "dark" ? `images/dark/${name}.png` : `images/${name}.png`);
  function setTheme(t) {
    root.dataset.theme = t;
    store.set("pntome-site-theme", t);
    $("#featImg").src = shotSrc(FEATS.find((f) => f.id === feature).img);
  }
  $("#themeBtn").addEventListener("click", () => setTheme(root.dataset.theme === "dark" ? "sepia" : "dark"));

  // ---------------------------------------------------------------- Language
  const EN = {
    navLabel: "Page sections", navFeatures: "Features", navTry: "Try it", navDownload: "Download",
    themeLabel: "Switch between sepia and dark",
    heroTitle: "Your Kindle library, on a real bookshelf.",
    heroLead: "Read your personal documents, look up a word just by selecting it, and get to know the characters with X-Ray — in one Windows app, no Kindle app needed.",
    ctaWindows: "Download for Windows", ctaMore: "See the features",
    heroMeta: "Windows 10/11 · Free · Version 0.1.0",
    caseLabel: "Sample bookshelf", caseHint: "Hover to take a book out · click for details · drag to reorder",
    featTitle: "One app, four things.",
    tryTitle: "Try it right here.",
    tDict: "Look up", tGraph: "Relationship map", tStats: "Badges",
    sToday: "Today", sStreak: "Streak", sRead: "Read 10 more minutes",
    dlTitle: "Download pntome", dlLead: "Windows 10/11 · about 5 MB · free.", dlBtn: "Download the installer", dlSource: "Source on GitHub",
    dlNote: "The installer is not signed yet: if Windows warns you, choose “More info”, then “Run anyway”.",
    faqTitle: "Questions",
    q1: "Which books can I read?", a1: "Personal documents you send with Send to Kindle. Purchased books with DRM still show on the shelf but open in Kindle — the app never removes DRM.",
    q2: "Where does my data go?", a2: "Your library, notes and stats stay on your computer; sign-in keys live in Windows Credential Manager. AI runs only when you press the button, and only receives short passages from what you have read.",
    q3: "Does the dictionary need the internet?", a3: "Only the first time, to download Wiktionary and Open English WordNet. After that, lookups are offline.",
    q4: "Will X-Ray spoil the story?", a4: "No. By default everything stops at the page you are on.",
    footer: "pntome · a personal project, not affiliated with Amazon. Book covers on the shelf: Wikimedia Commons, public domain.",
  };
  const VI = {};
  for (const el of $$("[data-i18n]")) VI[el.dataset.i18n] = el.innerHTML;
  for (const el of $$("[data-i18n-attr]")) {
    const [attr, key] = el.dataset.i18nAttr.split(":");
    VI[key] = el.getAttribute(attr);
  }
  const T = (k) => (lang === "en" ? EN[k] ?? VI[k] : VI[k] ?? EN[k]);
  const L = (o) => (lang === "en" ? o.en : o.vi);

  function setLang(l) {
    lang = l;
    store.set("pntome-site-lang", l);
    root.lang = l;
    for (const el of $$("[data-i18n]")) el.innerHTML = T(el.dataset.i18n);
    for (const el of $$("[data-i18n-attr]")) {
      const [attr, key] = el.dataset.i18nAttr.split(":");
      el.setAttribute(attr, T(key));
    }
    for (const b of $$("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === l));
    // No mouse on phones: say what a finger can do.
    if (window.matchMedia("(hover: none)").matches) {
      $(".shelf__hint").textContent = l === "en" ? "Tap a book for details · swipe to see more" : "Chạm vào sách để xem · vuốt để xem thêm";
    }
    document.title = l === "en" ? "pntome — Your Kindle library, on a real bookshelf" : "pntome — Thư viện Kindle của bạn, trên một kệ sách thật";
    renderBooks();
    renderFeatures();
    showTry(tryPanel);
    resetDict();
    renderGraph();
    renderStats();
  }
  for (const b of $$("[data-lang]")) b.addEventListener("click", () => setLang(b.dataset.lang));

  // ---------------------------------------------------------------- Bookshelf
  const BOOKS = [
    { id: "kieu", cvi: "Trang đầu bản in Nôm “Kim Vân Kiều tân truyện”", cen: "First page of a Nôm print, “Kim Vân Kiều tân truyện”", img: "kieu", pos: "74% 50%", vi: "Truyện Kiều", en: "The Tale of Kieu", a: "Nguyễn Du", y: 1820, c: "#7a1f2b", s: "leather", w: 50, h: 182, nvi: "Truyện thơ Nôm 3.254 câu lục bát.", nen: "A verse novel of 3,254 lines in luc bat metre." },
    { id: "sodo", cvi: "Bìa ấn bản đầu tiên, 1938", cen: "First-edition cover, 1938", img: "sodo", vi: "Số đỏ", en: "Dumb Luck", a: "Vũ Trọng Phụng", y: 1936, c: "#c98a2c", s: "cloth", w: 38, h: 162, nvi: "Tiểu thuyết trào phúng về xã hội thành thị.", nen: "A satirical novel of city life." },
    { id: "demen", vi: "Dế Mèn phiêu lưu ký", en: "Diary of a Cricket", a: "Tô Hoài", y: 1941, c: "#2f5d50", s: "cloth", w: 44, h: 166, nvi: "Cuộc phiêu lưu của chú dế Mèn.", nen: "The adventures of a young cricket." },
    { id: "chipheo", vi: "Chí Phèo", en: "Chi Pheo", a: "Nam Cao", y: 1941, c: "#5b4636", s: "plain", w: 34, h: 150, nvi: "Truyện ngắn về một người nông dân bị tha hoá.", nen: "A short story about a peasant driven to ruin." },
    { id: "karamazov", cvi: "Trang đầu ấn bản đầu tiên, 1880", cen: "First page of the first edition, 1880", img: "karamazov", vi: "Anh em nhà Karamazov", en: "The Brothers Karamazov", a: "F. Dostoevsky", y: 1880, c: "#1f3a5f", s: "foil", w: 58, h: 188, nvi: "Tiểu thuyết cuối cùng của Dostoevsky.", nen: "Dostoevsky’s last novel." },
    { id: "demtrang", vi: "Đêm trắng", en: "White Nights", a: "F. Dostoevsky", y: 1848, c: "#e8dcc4", s: "plain", w: 30, h: 146, nvi: "Truyện vừa về bốn đêm ở Petersburg.", nen: "A novella of four nights in St Petersburg." },
    { id: "warpeace", cvi: "Ấn bản đầu tiên, 1869", cen: "First edition, 1869", img: "warpeace", vi: "Chiến tranh và hoà bình", en: "War and Peace", a: "L. Tolstoy", y: 1869, c: "#2a2a2e", s: "foil", w: 62, h: 186, nvi: "Bộ tiểu thuyết sử thi thời Napoléon.", nen: "An epic novel of the Napoleonic wars." },
    { id: "miserables", cvi: "Tranh Cosette của Émile Bayard, 1862", cen: "Cosette, by Émile Bayard, 1862", img: "miserables", vi: "Những người khốn khổ", en: "Les Misérables", a: "Victor Hugo", y: 1862, c: "#3b2f5c", s: "leather", w: 56, h: 184, nvi: "Câu chuyện đời Jean Valjean.", nen: "The life of Jean Valjean." },
    { id: "pride", cvi: "Trang tên sách ấn bản đầu tiên, 1813", cen: "First-edition title page, 1813", img: "pride", vi: "Kiêu hãnh và định kiến", en: "Pride and Prejudice", a: "Jane Austen", y: 1813, c: "#8a9a7b", s: "cloth", w: 42, h: 164, nvi: "Elizabeth Bennet và anh chàng Darcy.", nen: "Elizabeth Bennet and Mr Darcy." },
    { id: "montecristo", cvi: "Tranh “Dantès trên đá” của Louis Français", cen: "“Dantès on his rock”, by Louis Français", img: "montecristo", vi: "Bá tước Monte Cristo", en: "The Count of Monte Cristo", a: "A. Dumas", y: 1844, c: "#7a1f2b", s: "foil", w: 54, h: 180, nvi: "Câu chuyện báo thù của Edmond Dantès.", nen: "Edmond Dantès and his revenge." },
    { id: "tramnam", vi: "Trăm năm cô đơn", en: "One Hundred Years of Solitude", a: "G. García Márquez", y: 1967, c: "#b5452f", s: "foil", w: 52, h: 182, nvi: "Bảy thế hệ nhà Buendía ở Macondo.", nen: "Seven generations of the Buendía family in Macondo." },
    { id: "moby", cvi: "Trang tên sách ấn bản đầu tiên, 1851", cen: "First-edition title page, 1851", img: "moby", vi: "Moby-Dick", en: "Moby-Dick", a: "H. Melville", y: 1851, c: "#1f3a5f", s: "cloth", w: 46, h: 176, nvi: "Cuộc săn con cá voi trắng.", nen: "The hunt for the white whale." },
    { id: "wuthering", cvi: "Trang tên sách ấn bản đầu tiên, 1847", cen: "First-edition title page, 1847", img: "wuthering", vi: "Đồi gió hú", en: "Wuthering Heights", a: "Emily Brontë", y: 1847, c: "#5b4636", s: "plain", w: 40, h: 172, nvi: "Tiểu thuyết duy nhất của Emily Brontë.", nen: "Emily Brontë’s only novel." },
    { id: "prince", vi: "Hoàng tử bé", en: "The Little Prince", a: "A. de Saint-Exupéry", y: 1943, c: "#2f5d50", s: "plain", w: 30, h: 140, nvi: "Chuyện về một hoàng tử từ tiểu hành tinh.", nen: "A prince from a small asteroid." },
  ];
  let order = BOOKS.map((b) => b.id);
  const byId = new Map(BOOKS.map((b) => [b.id, b]));
  const row = $("#shelfRow");
  const shelf = $(".shelf");

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  const inkFor = (b) => (b.s === "foil" ? "#e9c46a" : luminance(b.c) > 0.36 ? "#1d1a16" : "#f6efe2");

  function slotEl(b) {
    const slot = document.createElement("div");
    const title = L(b);
    slot.className = "slot";
    slot.tabIndex = 0;
    slot.dataset.id = b.id;
    slot.setAttribute("role", "button");
    slot.setAttribute("aria-label", `${title} — ${b.a}`);
    // Room the turned book needs: its cover on screen (~0.85 of the depth) minus the spine it replaces.
    slot.style.setProperty("--push", `${Math.max(10, Math.round(0.85 * 0.68 * b.h - b.w + 12))}px`);
    const book = document.createElement("div");
    book.className = `book book--${b.s}${b.w < 36 ? " book--caps" : ""}`;
    book.style.cssText = `--w:${b.w}px;--h:${b.h}px;--c:${b.c};--ink:${inkFor(b)};--band:${b.s === "foil" ? "#e9c46a" : "rgba(255,255,255,.35)"};--fs:${Math.max(11, Math.min(15, b.w * 0.3))}px`;
    book.innerHTML = `<div class="book__spine"><span class="book__title"></span><span class="book__author"></span></div>
      <div class="book__cover"><div><b></b><i></i><span class="a"></span></div><span class="y"></span></div>`;
    $(".book__title", book).textContent = title;
    $(".book__author", book).textContent = b.a.split(" ").pop();
    $(".book__cover b", book).textContent = title;
    $(".book__cover .a", book).textContent = b.a;
    $(".book__cover .y", book).textContent = String(b.y);
    if (b.img) {
      // A real first-edition cover or title page (public domain, Wikimedia Commons).
      const cover = $(".book__cover", book);
      const im = Object.assign(document.createElement("img"), { src: `covers/${b.img}.jpg`, alt: "", loading: "lazy", decoding: "async" });
      if (b.pos) im.style.objectPosition = b.pos;
      cover.replaceChildren(im);
      cover.classList.add("book__cover--img");
    }
    slot.append(book);
    return slot;
  }

  let card = null;
  function closeCard() {
    card?.remove();
    card = null;
    for (const s of $$(".slot.is-out")) s.classList.remove("is-out");
  }
  function toggleCard(slot) {
    const wasOut = slot.classList.contains("is-out");
    closeCard();
    if (wasOut) return;
    const b = byId.get(slot.dataset.id);
    slot.classList.add("is-out");
    card = document.createElement("div");
    card.className = "book-card";
    card.innerHTML = "<b></b><span></span><p></p>";
    $("b", card).textContent = L(b);
    $("span", card).textContent = `${b.a} · ${b.y}`;
    $("p", card).textContent = lang === "en" ? b.nen : b.nvi;
    if (b.img) card.append(Object.assign(document.createElement("small"), { textContent: `${lang === "en" ? b.cen : b.cvi} · Wikimedia Commons` }));
    shelf.append(card);
    const sr = shelf.getBoundingClientRect();
    const r = slot.getBoundingClientRect();
    // Right of the turned cover (the slot is only the spine; the cover takes --push more).
    const push = parseFloat(slot.style.getPropertyValue("--push")) || 0;
    let left = r.right - sr.left + push + 22;
    if (left + card.offsetWidth > sr.width - 8) left = r.left - sr.left - card.offsetWidth - 16;
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${Math.max(0, r.top - sr.top)}px`;
  }
  // On wide screens the row keeps its resting width, so a book making room only pushes
  // the books to its right and never slides the row out from under the pointer.
  const narrow = window.matchMedia("(max-width: 760px)");
  function fixRowWidth() {
    row.style.width = "";
    if (narrow.matches) return;
    row.style.width = "max-content";
    row.style.width = `${row.offsetWidth}px`;
  }
  narrow.addEventListener?.("change", fixRowWidth);
  function renderBooks() {
    closeCard();
    row.replaceChildren(...order.map((id) => slotEl(byId.get(id))));
    fixRowWidth();
  }

  row.addEventListener("keydown", (e) => {
    const slot = e.target.closest?.(".slot");
    if (!slot) return;
    const all = $$(".slot", row);
    const i = all.indexOf(slot);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      all[(i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length].focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleCard(slot);
    } else if (e.key === "Escape") closeCard();
  });
  document.addEventListener("click", (e) => {
    if (card && !e.target.closest(".slot, .book-card")) closeCard();
  });

  // Drag to reorder (mouse and pen); a tap or click opens the card.
  let drag = null;
  row.addEventListener("pointerdown", (e) => {
    const slot = e.target.closest(".slot");
    if (!slot || e.button !== 0) return;
    drag = { slot, x: e.clientX, y: e.clientY, started: false, touch: e.pointerType === "touch" };
    if (!drag.touch) slot.setPointerCapture(e.pointerId);
  });
  row.addEventListener("pointermove", (e) => {
    if (!drag || drag.touch) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.started = true;
      closeCard();
      const r = drag.slot.getBoundingClientRect();
      drag.dx = e.clientX - r.left;
      drag.dy = e.clientY - r.top;
      drag.ghost = drag.slot.cloneNode(true);
      drag.ghost.className = "ghost-book";
      drag.ghost.style.width = `${r.width}px`;
      drag.ghost.style.height = `${r.height}px`;
      document.body.append(drag.ghost);
      drag.slot.classList.add("is-dragging");
      shelf.classList.add("is-target");
    }
    drag.ghost.style.left = `${e.clientX - drag.dx}px`;
    drag.ghost.style.top = `${e.clientY - drag.dy}px`;
    const before = $$(".slot", row).filter((s) => s !== drag.slot).find((s) => {
      const r = s.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2;
    });
    if (before) row.insertBefore(drag.slot, before);
    else row.append(drag.slot);
  });
  const endDrag = (e) => {
    if (!drag) return;
    const { slot, started } = drag;
    if (started) {
      drag.ghost.remove();
      slot.classList.remove("is-dragging");
      shelf.classList.remove("is-target");
      order = $$(".slot", row).map((s) => s.dataset.id);
      slot.focus({ preventScroll: true });
    } else if (e.type === "pointerup" && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) toggleCard(slot);
    drag = null;
  };
  row.addEventListener("pointerup", endDrag);
  row.addEventListener("pointercancel", endDrag);

  // ---------------------------------------------------------------- Feature tabs
  const FEATS = [
    { id: "library", img: "library", vi: "Thư viện", en: "Library",
      tvi: "Sách xếp theo trạng thái đọc trên kệ gỗ, kéo thả để sắp xếp.", ten: "Books stand on wooden shelves by reading status; drag to rearrange.",
      cvi: ["Đồng bộ từ Amazon", "Tuỳ chỉnh gáy và bìa", "Gửi EPUB lên Kindle"], cen: ["Synced from Amazon", "Custom spines and covers", "Send EPUB to Kindle"] },
    { id: "reader", img: "reader", vi: "Trình đọc", en: "Reader",
      tvi: "Tài liệu cá nhân mở ngay trong app, trên nền giấy dịu mắt.", ten: "Personal documents open right in the app, on a page that is easy on the eyes.",
      cvi: ["Đồng bộ vị trí với Kindle", "Đánh dấu và ghi chú", "Tìm không cần dấu"], cen: ["Position synced with Kindle", "Highlights and notes", "Search without diacritics"] },
    { id: "xray", img: "graph", vi: "X-Ray", en: "X-Ray",
      tvi: "Nhân vật và quan hệ của họ, chỉ tính tới trang bạn đang đọc.", ten: "The characters and how they relate, only up to the page you are on.",
      cvi: ["Sơ đồ quan hệ", "Hiểu truyện kể ngôi thứ nhất", "Nhãn AI tuỳ chọn"], cen: ["Relationship map", "Understands first-person stories", "Optional AI labels"] },
    { id: "stats", img: "stats", vi: "Thống kê", en: "Stats",
      tvi: "Mục tiêu mỗi ngày, chuỗi ngày đọc và 13 huy hiệu.", ten: "A daily goal, a reading streak and 13 badges.",
      cvi: ["Tính cả giờ đọc trên Kindle", "Bản đồ nhiệt cả năm", "Bốn cấp huy hiệu"], cen: ["Counts Kindle reading too", "A year-long heatmap", "Four badge tiers"] },
  ];
  function renderFeatures() {
    const tabs = $("#featTabs");
    tabs.replaceChildren(...FEATS.map((f) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(f.id === feature));
      b.textContent = L(f);
      b.addEventListener("click", () => showFeature(f.id));
      return b;
    }));
    const f = FEATS.find((x) => x.id === feature);
    $("#featText").textContent = lang === "en" ? f.ten : f.tvi;
    $("#featChips").replaceChildren(...(lang === "en" ? f.cen : f.cvi).map((c) => Object.assign(document.createElement("li"), { textContent: c })));
    const img = $("#featImg");
    img.alt = L(f);
    const src = shotSrc(f.img);
    if (!img.src.endsWith(src)) {
      img.classList.add("is-fading");
      setTimeout(() => {
        img.src = src;
        img.onload = () => img.classList.remove("is-fading");
      }, 150);
    }
  }
  function showFeature(id) {
    feature = id;
    renderFeatures();
  }
  for (const f of FEATS) new Image().src = `images/${f.img}.png`; // warm the cache for quick tab switches

  // ---------------------------------------------------------------- Try-it tabs
  const HINTS = {
    dict: { vi: "Nhấp đúp hoặc bôi đen một từ — thử “mái chèo”, “sương” hay “lặng lẽ”.", en: "Double-click or select a word — try “oar”, “mist” or “quietly”." },
    graph: { vi: "Rê chuột vào một người để làm nổi quan hệ, bấm để xem giới thiệu.", en: "Hover a person to highlight their ties, click to see who they are." },
    stats: { vi: "Bấm “Đọc thêm 10 phút” để đạt mục tiêu hôm nay. Dữ liệu minh hoạ.", en: "Press “Read 10 more minutes” to reach today’s goal. Sample data." },
  };
  function showTry(id) {
    tryPanel = id;
    for (const b of $$("#tryTabs button")) b.setAttribute("aria-selected", String(b.dataset.panel === id));
    for (const p of $$(".panel")) p.hidden = p.dataset.panel !== id;
    $("#tryHint").textContent = L(HINTS[id]);
  }
  for (const b of $$("#tryTabs button")) b.addEventListener("click", () => showTry(b.dataset.panel));

  // ---------------------------------------------------------------- Dictionary demo
  const PASSAGE = {
    vi: "Chiều xuống chậm trên bến sông. Con đò cuối ngày lặng lẽ rời bờ, mái chèo khua nước thành những vòng sóng nhỏ. Bên kia sông, khói bếp đã bốc lên từ những mái nhà trong thôn, và sương bắt đầu giăng mờ trên bãi ngô.",
    en: "Evening came slowly to the river landing. The last ferry of the day slipped quietly from the bank, its oar stirring small rings on the water. Across the river, chimney smoke rose over the village, and a thin mist began to settle on the cornfields.",
  };
  // [part of speech, senses, part of speech, senses, …]
  const VIDICT = {
    "chiều": ["danh từ", [["Khoảng thời gian cuối ngày, từ quá trưa đến lúc tối.", "Chiều nay trời mát."], ["Phía, hướng.", "Đi ngược chiều gió."]]],
    "bến": ["danh từ", [["Chỗ ven sông, ven biển để thuyền đò đỗ và người lên xuống.", "Bến đò đầu làng."]]],
    "bến sông": ["danh từ", [["Chỗ bờ sông có thuyền đò ghé đỗ.", "Ra bến sông giặt áo."]]],
    "đò": ["danh từ", [["Thuyền nhỏ chở người qua sông hoặc đi quãng ngắn.", "Chuyến đò cuối ngày."]]],
    "con đò": ["danh từ", [["Chiếc đò; cách gọi thân mật trong văn chương.", "Con đò nằm im bên bến."]]],
    "lặng lẽ": ["tính từ", [["Im lặng, không gây tiếng động, như không muốn ai để ý.", "Lặng lẽ ra đi."]]],
    "mái chèo": ["danh từ", [["Dụng cụ bằng gỗ, một đầu dẹt, dùng để đẩy nước cho thuyền đi.", "Khua mái chèo."]]],
    "chèo": ["động từ", [["Dùng mái chèo đẩy nước cho thuyền đi.", "Chèo đò qua sông."]], "danh từ", [["Loại kịch hát dân gian của vùng đồng bằng Bắc Bộ.", "Xem hát chèo."]]],
    "khua": ["động từ", [["Làm cho vật chạm vào nhau hoặc vào nước, phát ra tiếng.", "Khua mái chèo."]]],
    "vòng": ["danh từ", [["Đường cong khép kín.", "Vòng sóng loang dần."]]],
    "sóng": ["danh từ", [["Khối nước dâng lên hạ xuống trên mặt sông, mặt biển.", "Sóng vỗ mạn thuyền."]]],
    "khói": ["danh từ", [["Chất khí có màu bốc lên từ vật đang cháy.", "Khói lam chiều."]]],
    "khói bếp": ["danh từ", [["Khói từ bếp nấu ăn bốc lên, thường gợi cảnh làng quê lúc chiều.", "Khói bếp vương trên mái rạ."]]],
    "bếp": ["danh từ", [["Chỗ đặt lửa để nấu ăn.", "Nhóm bếp."]]],
    "thôn": ["danh từ", [["Khu dân cư nhỏ ở nông thôn, thuộc một xã.", "Đầu thôn có cây đa."]]],
    "sương": ["danh từ", [["Hơi nước đọng thành hạt rất nhỏ, lơ lửng gần mặt đất về đêm và sáng sớm.", "Sương sớm còn đọng trên lá."]]],
    "giăng": ["động từ", [["Trải ra, phủ thành một lớp rộng.", "Sương giăng mặt hồ."]]],
    "mờ": ["tính từ", [["Không rõ nét, khó nhìn thấy.", "Dáng núi mờ trong sương."]]],
    "ngô": ["danh từ", [["Cây lương thực thân thẳng, hạt mọc thành bắp.", "Bãi ngô ven sông."]]],
    "bãi": ["danh từ", [["Khoảng đất rộng, bằng, thường ở ven sông.", "Bãi bồi."]]],
    "rời": ["động từ", [["Đi khỏi một chỗ.", "Rời bến."]]],
    "bờ": ["danh từ", [["Dải đất giáp với mặt nước.", "Bờ sông."]]],
  };
  const ENDICT = {
    evening: ["noun", "buổi tối, chiều tối", "The latter part of the day, from late afternoon until dark."],
    landing: ["noun", "bến (thuyền)", "A place where boats stop to let people on or off."],
    ferry: ["noun", "phà, đò", "A boat that carries people or goods across a stretch of water."],
    slipped: ["verb", "lướt, lẻn đi", "Moved smoothly and quietly, almost without being noticed."],
    quietly: ["adverb", "lặng lẽ, khẽ khàng", "In a way that makes little or no noise."],
    bank: ["noun", "bờ (sông)", "The land along the side of a river."],
    oar: ["noun", "mái chèo", "A long pole with a flat end, used to row a boat."],
    stirring: ["verb", "khuấy, làm gợn", "Moving gently so that the surface is disturbed."],
    rings: ["noun", "vòng", "Circles, such as the ripples spreading on water."],
    chimney: ["noun", "ống khói", "A pipe that carries smoke up from a fire and out of a building."],
    smoke: ["noun", "khói", "The grey or white cloud given off by something burning."],
    village: ["noun", "làng, thôn", "A small group of houses in the countryside."],
    mist: ["noun", "sương mù", "A thin cloud of tiny water drops near the ground."],
    settle: ["verb", "lắng xuống, phủ xuống", "To come to rest and stay over an area."],
    cornfields: ["noun", "ruộng ngô", "Fields where corn (maize) is grown."],
    river: ["noun", "sông", "A large natural stream of water flowing to the sea or a lake."],
  };
  const paper = $("#dictPage");
  const textEl = $("#dictText");
  const bar = $("#hlbar");
  const dict = $("#dict");
  let selRange = null;

  function resetDict() {
    textEl.textContent = PASSAGE[lang];
    bar.hidden = true;
    dict.hidden = true;
    selRange = null;
  }
  const norm = (s) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\s'-]/gu, "").replace(/\s+/g, " ").trim();
  function lookupWord(sel, range) {
    const table = lang === "en" ? ENDICT : VIDICT;
    const w = norm(sel);
    if (table[w]) return w;
    // Grow to a compound with the next or previous word ("mái" → "mái chèo").
    const words = norm(textEl.textContent).split(" ");
    const at = norm(range.startContainer.textContent.slice(0, range.startOffset)).split(" ").filter(Boolean).length;
    const n = w.split(" ").length;
    for (const [a, b] of [[at, at + n + 1], [at - 1, at + n]]) {
      if (a < 0) continue;
      const c = words.slice(a, b).join(" ");
      if (table[c]) return c;
    }
    return w;
  }
  function showDict(word) {
    $("#dictWord").textContent = word;
    const isEn = lang === "en";
    const names = isEn ? ["English–Vietnamese", "English", "Wiktionary"] : ["Việt – Việt", "Wiktionary", "Wikipedia"];
    const tabs = $("#dictTabs");
    const body = $("#dictBody");
    const add = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
    function fill(i) {
      body.replaceChildren();
      if (isEn) {
        const e = ENDICT[word];
        if (i === 2 || !e) return body.append(add("p", "muted", e ? "Needs a connection — the app opens the full page." : `“${word}” is not in this demo.`));
        body.append(add("div", "dict__pos", e[0]), add("p", null, i === 0 ? e[1] : e[2]));
        return;
      }
      const e = VIDICT[word];
      if (i > 0 || !e) return body.append(add("p", "muted", e ? "Cần mạng — trong app mục này mở trang đầy đủ." : `Bản demo chưa có “${word}”.`));
      for (let g = 0; g < e.length; g += 2) {
        body.append(add("div", "dict__pos", e[g]));
        const ol = add("ol");
        for (const [d, ex] of e[g + 1]) {
          const li = add("li", null, d);
          li.append(add("em", null, ex));
          ol.append(li);
        }
        body.append(ol);
      }
    }
    tabs.replaceChildren(...names.map((n, i) => {
      const b = add("button", null, n);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(i === 0));
      b.addEventListener("click", () => {
        for (const x of tabs.children) x.setAttribute("aria-selected", String(x === b));
        fill(i);
      });
      return b;
    }));
    fill(0);
  }
  function place(el, r, below) {
    const pr = paper.getBoundingClientRect();
    el.hidden = false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(pr.width - w - 8, r.left - pr.left + r.width / 2 - w / 2))}px`;
    const room = pr.bottom - r.bottom - 10;
    const top = below && room >= h + 8 ? r.bottom - pr.top + 10 : r.top - pr.top - h - 10;
    el.style.top = `${Math.max(6, top)}px`;
  }
  function onSelect() {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return;
    const range = s.getRangeAt(0);
    if (!textEl.contains(range.commonAncestorContainer)) return;
    const text = s.toString().trim();
    if (!text || text.length > 40) return;
    selRange = range.cloneRange();
    const r = range.getBoundingClientRect();
    place(bar, r, false);
    showDict(lookupWord(text, range));
    place(dict, r, true);
  }
  textEl.addEventListener("mouseup", () => setTimeout(onSelect, 0));
  textEl.addEventListener("keyup", (e) => e.shiftKey && onSelect());
  textEl.addEventListener("touchend", () => setTimeout(onSelect, 250));
  $("#dictClose").addEventListener("click", () => { dict.hidden = true; });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#dictPage")) { bar.hidden = true; dict.hidden = true; }
  });
  for (const dot of $$(".hlbar__dot")) {
    dot.addEventListener("mousedown", (e) => e.preventDefault());
    dot.addEventListener("click", () => {
      if (!selRange) return;
      const m = document.createElement("mark");
      m.className = `hl hl--${dot.dataset.color}`;
      try { selRange.surroundContents(m); } catch { return; }
      window.getSelection()?.removeAllRanges();
      bar.hidden = true;
      selRange = null;
    });
  }

  // ---------------------------------------------------------------- Relationship map demo
  const NODES = [
    { id: "toi", vi: "Tôi (người kể)", en: "I (narrator)", ini: "T", x: 360, y: 196, r: 27, narrator: true, dvi: "Cậu bé kể chuyện, lớn lên bên bà ở làng ven sông.", den: "The boy telling the story, raised by his grandmother in a river village." },
    { id: "ba", vi: "Bà Tư", en: "Grandma Tư", ini: "BT", x: 150, y: 92, r: 22, dvi: "Bà nội của người kể, bán nước chè ở bến đò.", den: "The narrator’s grandmother, who sells tea at the ferry landing." },
    { id: "phuc", vi: "Thầy Phúc", en: "Teacher Phúc", ini: "TP", x: 128, y: 300, r: 19, dvi: "Thầy giáo làng, dạy người kể đọc chữ.", den: "The village teacher who taught the narrator to read." },
    { id: "minh", vi: "Chú Minh", en: "Uncle Minh", ini: "CM", x: 545, y: 88, r: 22, dvi: "Chú của người kể, lái đò trên sông.", den: "The narrator’s uncle, a ferryman." },
    { id: "hanh", vi: "Cô Hạnh", en: "Aunt Hạnh", ini: "CH", x: 664, y: 204, r: 18, dvi: "Vợ chú Minh, giữ quán bên kia sông.", den: "Uncle Minh’s wife, who keeps a shop across the river." },
    { id: "dung", vi: "Dũng", en: "Dũng", ini: "D", x: 565, y: 318, r: 18, dvi: "Lái buôn ở chợ huyện, đối thủ của chú Minh.", den: "A trader from the market town, Uncle Minh’s rival." },
    { id: "lan", vi: "Lan", en: "Lan", ini: "L", x: 382, y: 342, r: 18, dvi: "Bạn thân của người kể, con gái người đánh cá.", den: "The narrator’s best friend, a fisherman’s daughter." },
  ];
  const EDGES = [
    { a: "toi", b: "ba", k: "family", s: 5, vi: "bà – cháu", en: "grandmother – grandson", px: 254, py: 146 },
    { a: "toi", b: "minh", k: "family", s: 4, vi: "chú – cháu", en: "uncle – nephew", px: 452, py: 140 },
    { a: "minh", b: "hanh", k: "family", s: 3, vi: "chồng – vợ", en: "husband – wife", px: 618, py: 160 },
    { a: "toi", b: "phuc", k: "social", s: 3, vi: "thầy – trò", en: "teacher – pupil", px: 236, py: 252 },
    { a: "ba", b: "phuc", k: "social", s: 2, vi: "cùng làng", en: "neighbours", px: 130, py: 196 },
    { a: "toi", b: "lan", k: "social", s: 4, vi: "bạn thân", en: "best friends", px: 384, py: 276 },
    { a: "lan", b: "dung", k: "love", s: 3, vi: "người yêu", en: "sweethearts", px: 474, py: 340 },
    { a: "dung", b: "minh", k: "conflict", s: 3, vi: "đối thủ", en: "rivals", px: 560, py: 205 },
  ];
  const KINDS = [["family", "Gia đình", "Family"], ["love", "Tình cảm", "Romance"], ["conflict", "Xung đột", "Conflict"], ["social", "Quen biết", "Acquainted"]];
  const hiddenKinds = new Set();
  let focusNode = null;
  const svg = $("#graphSvg");
  const NS = "http://www.w3.org/2000/svg";
  const make = (tag, attrs = {}, parent) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent?.append(el);
    return el;
  };
  const nodeById = new Map(NODES.map((n) => [n.id, n]));

  function renderGraph() {
    svg.replaceChildren();
    const gE = make("g", {}, svg);
    const gP = make("g", {}, svg);
    const gN = make("g", {}, svg);
    for (const e of EDGES) {
      if (hiddenKinds.has(e.k)) continue;
      const A = nodeById.get(e.a);
      const B = nodeById.get(e.b);
      const g = make("g", { class: `g-edge g-edge--${e.k}`, "data-a": e.a, "data-b": e.b }, gE);
      make("line", { x1: A.x, y1: A.y, x2: B.x, y2: B.y, "stroke-width": 1 + e.s * 0.6 }, g);
      const label = L(e);
      const w = label.length * 6.6 + 28;
      const p = make("g", { class: `g-pill g-edge--${e.k}`, transform: `translate(${e.px},${e.py})`, "data-a": e.a, "data-b": e.b }, gP);
      make("rect", { x: -w / 2, y: -11, width: w, height: 22, rx: 11 }, p);
      make("circle", { cx: -w / 2 + 12, cy: 0, r: 3.5 }, p);
      make("text", { x: -w / 2 + 20, y: 0.5 }, p).textContent = label;
    }
    for (const n of NODES) {
      const g = make("g", { class: `g-node${n.narrator ? " is-narrator" : ""}`, transform: `translate(${n.x},${n.y})`, tabindex: 0, role: "button", "data-id": n.id }, gN);
      g.setAttribute("aria-label", L(n));
      make("circle", { r: n.r }, g);
      make("text", { class: "ini" }, g).textContent = lang === "en" && n.narrator ? "I" : n.ini;
      make("text", { class: "name", y: n.r + 17 }, g).textContent = L(n);
      g.addEventListener("pointerenter", () => dimFor(n.id));
      g.addEventListener("pointerleave", () => dimFor(focusNode));
      g.addEventListener("click", () => showPerson(focusNode === n.id ? null : n.id));
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          showPerson(focusNode === n.id ? null : n.id);
        }
      });
    }
    $("#graphLegend").replaceChildren(...KINDS.map(([k, vi, en]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `g-edge--${k}`;
      b.setAttribute("aria-pressed", String(!hiddenKinds.has(k)));
      b.innerHTML = `<svg viewBox="0 0 22 8" aria-hidden="true"><line x1="2" y1="4" x2="20" y2="4" ${k === "conflict" ? 'stroke-dasharray="5 3"' : ""}/></svg>`;
      b.append(lang === "en" ? en : vi);
      b.addEventListener("click", () => {
        if (hiddenKinds.has(k)) hiddenKinds.delete(k);
        else hiddenKinds.add(k);
        renderGraph();
      });
      return b;
    }));
    showPerson(focusNode);
  }
  function dimFor(id) {
    const near = id ? new Set([id, ...EDGES.filter((e) => !hiddenKinds.has(e.k) && (e.a === id || e.b === id)).flatMap((e) => [e.a, e.b])]) : null;
    for (const el of $$(".g-edge, .g-pill", svg)) el.classList.toggle("is-dim", !!id && el.dataset.a !== id && el.dataset.b !== id);
    for (const el of $$(".g-node", svg)) {
      el.classList.toggle("is-dim", !!near && !near.has(el.dataset.id));
      el.classList.toggle("is-on", el.dataset.id === focusNode);
    }
  }
  function showPerson(id) {
    focusNode = id;
    const c = $("#graphCard");
    dimFor(id);
    c.classList.toggle("is-empty", !id);
    if (!id) {
      c.textContent = lang === "en" ? "Click a person to see who they are." : "Bấm vào một người để xem giới thiệu.";
      return;
    }
    const n = nodeById.get(id);
    c.replaceChildren();
    const b = Object.assign(document.createElement("b"), { textContent: L(n) });
    const p = Object.assign(document.createElement("p"), { textContent: lang === "en" ? n.den : n.dvi });
    const ul = document.createElement("ul");
    for (const e of EDGES.filter((x) => x.a === id || x.b === id)) {
      const o = nodeById.get(e.a === id ? e.b : e.a);
      const li = document.createElement("li");
      li.className = `g-edge--${e.k}`;
      li.append(document.createElement("i"), L(o), Object.assign(document.createElement("span"), { textContent: L(e) }));
      ul.append(li);
    }
    c.append(b, p, ul);
  }
  svg.addEventListener("click", (e) => { if (e.target === svg) showPerson(null); });

  // ---------------------------------------------------------------- Badges demo
  const GOAL = 30;
  const state = { today: 20, streak: 13, minutes: 49 * 60 + 40, done: false };
  const BADGES = [
    { id: "streak", vi: "Bền bỉ", en: "Steady", tiers: [3, 7, 14, 30], v: () => state.streak, dvi: (v) => `Chuỗi ${v} ngày`, den: (v) => `${v}-day streak` },
    { id: "hours", vi: "Thời gian vàng", en: "Golden hours", tiers: [5, 20, 50, 150], v: () => Math.floor(state.minutes / 60), dvi: (v) => `${v} giờ đọc`, den: (v) => `${v} hours read` },
    { id: "books", vi: "Mọt sách", en: "Bookworm", tiers: [1, 10, 25, 100], v: () => 25, dvi: (v) => `${v} cuốn đã xong`, den: (v) => `${v} books finished` },
    { id: "night_owl", vi: "Cú đêm", en: "Night owl", tiers: [1, 10, 30, 100], v: () => 0, dvi: () => "Đọc khuya 0h–4h", den: () => "Read after midnight" },
  ];
  const TIER = ["", "#c47a3d", "#a9b4c2", "#e9b949", "#6fd3ff"];
  const TIER_VI = ["Chưa mở", "Đồng", "Bạc", "Vàng", "Kim cương"];
  const TIER_EN = ["Locked", "Bronze", "Silver", "Gold", "Diamond"];
  const tierOf = (b) => b.tiers.filter((t) => b.v() >= t).length;

  function renderStats() {
    const C = 2 * Math.PI * 18;
    const fill = $("#ringFill");
    fill.style.strokeDasharray = String(C);
    fill.style.strokeDashoffset = String(C * (1 - Math.min(1, state.today / GOAL)));
    $("#todayText").textContent = `${state.today}/${GOAL} ${lang === "en" ? "min" : "phút"}`;
    $("#streakText").textContent = `${state.streak} ${lang === "en" ? "days" : "ngày"}`;
    $("#streakCard").classList.toggle("is-lit", state.done);
    $("#badges").replaceChildren(...BADGES.map((b) => {
      const t = tierOf(b);
      const el = document.createElement("div");
      el.className = `badge${t ? "" : " is-locked"}`;
      el.dataset.id = b.id;
      el.style.setProperty("--tier", TIER[t] || "transparent");
      el.innerHTML = `<div class="badge__img"><img src="badges/${b.id}.png" alt="" width="52" height="52" loading="lazy" /></div><b></b><span></span>`;
      $("b", el).textContent = L(b);
      $("span", el).textContent = `${(lang === "en" ? TIER_EN : TIER_VI)[t]} · ${lang === "en" ? b.den(b.v()) : b.dvi(b.v())}`;
      return el;
    }));
  }
  let toastTimer = 0;
  $("#readMore").addEventListener("click", () => {
    const before = new Map(BADGES.map((b) => [b.id, tierOf(b)]));
    state.today += 10;
    state.minutes += 10;
    let msg = "";
    if (!state.done && state.today >= GOAL) {
      state.done = true;
      state.streak += 1;
      $("#streakCard").classList.add("is-bump");
      setTimeout(() => $("#streakCard").classList.remove("is-bump"), 700);
      msg = lang === "en" ? `Goal reached — ${state.streak}-day streak.` : `Đạt mục tiêu — chuỗi ${state.streak} ngày.`;
    }
    renderStats();
    for (const b of BADGES) {
      const t = tierOf(b);
      if (t > before.get(b.id)) {
        $(`.badge[data-id="${b.id}"]`).classList.add("is-up");
        msg = lang === "en" ? `Badge unlocked: ${b.en} · ${TIER_EN[t]}` : `Mở khoá huy hiệu ${b.vi} · ${TIER_VI[t]}`;
      }
    }
    if (msg) {
      const el = $("#toast");
      el.textContent = msg;
      el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
    }
  });

  setTheme(store.get("pntome-site-theme") === "dark" ? "dark" : "sepia");
  setLang(lang);
})();
