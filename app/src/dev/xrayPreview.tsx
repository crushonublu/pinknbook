// Dev-only page (xray-preview.html): the phone X-Ray on a made-up book
// (xrayFixture.ts), with the Tauri commands mocked. Open it through
// `npm run dev`, in a phone-sized window with an Android user agent (the
// X-Ray reads the platform from it):
//
//   /xray-preview.html [&lang=vi|en] [&at=0.45]   (the reader's place, 0–1)
//                      [&who=Mira Vance]           (open that person's page)
//                      [&map=1]                    (open the relationship map)
//                      [&ai=0]                     (no AI notes: rules only)
//                      [&whole=1]                  (the whole book, spoilers allowed)

import { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import "../App.css";
import "../mobile/mobile.css";
import "../mobile/reader.css";
import "../mobile/xray.css";
import { installFonts } from "../fonts";
import { type Lang } from "../i18n";
import { MobileReaderSheet } from "../mobile/MobileReaderSheet";
import { useXray, XRayPanel } from "../XRay";
import { pairKey, type Mention } from "../xrayIndex";
import { chapterOf, fakeView } from "./xrayFixture";

const q = new URLSearchParams(location.search);
const lang: Lang = q.get("lang") === "en" ? "en" : "vi";
const at = Math.min(1, Math.max(0.01, Number(q.get("at") ?? "0.45") || 0.45));
const withAi = q.get("ai") !== "0";

document.documentElement.dataset.theme = "dark";
document.documentElement.classList.add("is-android");
installFonts();

/** What the AI would have said, up to 30% of the book. */
const upTo = 0.3;
const AI = {
  upTo,
  descriptions: {
    "Mira Vance": { text: "Người sáng lập Lumen, bỏ học ở Stanford để làm máy xét nghiệm máu. Cô thuyết phục mọi người bằng niềm tin của mình.", upTo },
    "Sam Kader": { text: "Giám đốc vận hành của Lumen, người góp vốn đầu tiên; quản lý nhân viên rất gắt.", upTo },
    "Ian Price": { text: "Nhà hoá học đầu tiên của Lumen, trầm lặng và cẩn thận.", upTo },
  },
  labels: {
    [pairKey("Daniel Vance", "Mira Vance")]: { label: "cha – con gái", detail: "Daniel là cha của Mira.", upTo },
    [pairKey("Mira Vance", "Ruth Vance")]: { label: "con gái – mẹ", detail: "Ruth là mẹ của Mira.", upTo },
    [pairKey("Mira Vance", "Owen Vance")]: { label: "chị – em trai", detail: "Owen là em trai của Mira.", upTo },
    [pairKey("Mira Vance", "Sam Kader")]: { label: "người yêu", detail: "Hai người yêu nhau mà không ai biết.", upTo },
    [pairKey("Hana Ito", "Mira Vance")]: { label: "cô giáo – học trò", detail: "Hana Ito dạy Mira ở Stanford.", upTo },
    [pairKey("Ian Price", "Mira Vance")]: { label: "nhân viên – sếp", detail: "Ian Price làm cho Mira.", upTo },
    [pairKey("George Brook", "Tyler Brook")]: { label: "ông – cháu", detail: "Tyler là cháu của George.", upTo },
    [pairKey("Sam Kader", "Tyler Brook")]: { label: "đe doạ – bị đe doạ", detail: "Sam doạ Tyler.", upTo },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
mockIPC((cmd: string): any => {
  if (cmd === "xray_load") return { idx: null, edits: null, ai: withAi ? JSON.stringify(AI) : null };
  return null;
});

function Preview() {
  const [log, setLog] = useState<string[]>([]);
  const view = useMemo(() => fakeView((w) => setLog((l) => [w, ...l].slice(0, 3))), []);
  const x = useXray(view, "PREVIEW", true, true, at, ["Nam Phong"]);
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [, setGraph] = useState(q.get("map") === "1");
  useEffect(() => {
    if (q.get("whole") === "1") x.setWholeBook(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const who = q.get("who");
    if (!x.ready || !who) return;
    const e = [...x.byKey.values()].find((v) => v.name === who || v.forms.includes(who));
    if (e) setSel(e.key);
  }, [x.ready, x.byKey]);

  const fmt = (f: number) => `${Math.round(f * 100)}%`;
  return (
    <div className="pv-phones">
      <div className="pv-phone">
        <div className="reader" style={{ position: "relative", height: "100%", background: "#f4efe4" }}>
          <p style={{ margin: 0, padding: "40px 24px", color: "#5c6370", fontSize: 15, lineHeight: 1.6 }}>
            {log.length ? `→ ${log[0]}` : "…"}
          </p>
          <MobileReaderSheet title="X-Ray" closeLabel="Đóng" onClose={() => undefined}>
            <XRayPanel
              lang={lang}
              x={x}
              view={view}
              bookTitle="Ánh Sáng Giả"
              selected={sel}
              onSelect={(k) => {
                setSel(k);
                setOpen(null);
              }}
              onOpenGraph={() => setGraph(true)}
              formatPos={fmt}
              onGo={(m: Mention) => setLog((l) => [`mention ${m[0]}:${m[1]} (${fmt(m[4])})`, ...l])}
              chapterOf={chapterOf}
              openMention={open}
              onOpenMention={setOpen}
            />
          </MobileReaderSheet>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Preview />);
