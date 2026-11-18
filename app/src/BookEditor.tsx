import { useEffect, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STR, type Lang } from "./i18n";
import { SPINE_FONTS, SPINE_STYLES, STATUS_ORDER, type LibraryRow, type ReadStatus, type SpineFont, type SpineStyle } from "./types";
import { Book3D } from "./Book3D";
import { autoWidth, SPINE_SWATCHES, type SpineLook } from "./spine";
import { statusLabel } from "./bookInfo";
import { Icon } from "./icons";

/** Downscale a picked image to a JPEG (max 1200 px tall) before storing it. */
async function prepareCover(file: File): Promise<number[]> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / bmp.height);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.9),
  );
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

type CoverChoice = "file" | "type" | "upload";

/**
 * Customise how a book shows in the library: display title and author,
 * cover (from the file, drawn from the title, or a picture), spine (colour,
 * material, lettering, thickness) and shelf. A 3D book on the left follows
 * every change and can be turned by dragging.
 */
export default function BookEditor({
  row,
  lang,
  onClose,
  onSaved,
}: {
  row: LibraryRow;
  lang: Lang;
  onClose: () => void;
  /** Called after saving; `status` is the new shelf if it changed (null = automatic). */
  onSaved: (status?: ReadStatus | null) => void;
}) {
  const t = STR[lang];
  const [title, setTitle] = useState(row.title);
  const [author, setAuthor] = useState(row.author);
  const hasCustomImage = !!row.cover && row.cover !== row.auto_cover;
  const initialCover: CoverChoice = row.typographic_cover ? "type" : hasCustomImage ? "upload" : "file";
  const [coverChoice, setCoverChoice] = useState<CoverChoice>(initialCover);
  const [upload, setUpload] = useState<{ bytes: number[]; preview: string } | null>(null);
  const initialColor = row.spine_color !== row.auto_spine_color ? row.spine_color : null;
  const [color, setColor] = useState<string | null>(initialColor);
  const [style, setStyle] = useState<SpineStyle>(row.spine_style ?? "plain");
  const [font, setFont] = useState<SpineFont>(row.spine_font ?? "serif");
  const [width, setWidth] = useState<number | null>(row.spine_width);
  const initialShelf = row.status_manual ? row.status : "auto";
  const [shelf, setShelf] = useState<ReadStatus | "auto">(initialShelf);
  const [turn, setTurn] = useState(-32);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.select();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => () => {
    if (upload) URL.revokeObjectURL(upload.preview);
  }, [upload]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const bytes = await prepareCover(file);
      setUpload({ bytes, preview: URL.createObjectURL(file) });
      setCoverChoice("upload");
      setTurn(-90);
    } catch (e) {
      setError(String(e));
    }
  }

  // What the preview shows.
  const autoW = autoWidth(row);
  const look: SpineLook = {
    color: color ?? row.auto_spine_color,
    style,
    font,
    width: width ?? autoW,
  };
  const previewRow = {
    ...row,
    title: title.trim() || row.auto_title,
    author: author.trim(),
    cover: coverChoice === "type" ? null : coverChoice === "file" ? row.auto_cover : row.cover ?? row.auto_cover,
  };
  const previewSrc = coverChoice === "upload" ? upload?.preview : undefined;

  // Drag on the stage turns the book.
  const dragFrom = useRef<{ x: number; turn: number } | null>(null);
  function onStageDown(e: PointerEvent<HTMLDivElement>) {
    dragFrom.current = { x: e.clientX, turn };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("is-turning");
  }
  function onStageMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragFrom.current) return;
    setTurn(dragFrom.current.turn + (e.clientX - dragFrom.current.x) * 0.6);
  }
  function onStageUp(e: PointerEvent<HTMLDivElement>) {
    dragFrom.current = null;
    e.currentTarget.classList.remove("is-turning");
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const norm = (v: string, auto: string) => (v.trim() === auto.trim() ? null : v.trim() || null);
      await invoke("set_book_info", {
        asin: row.asin,
        title: norm(title, row.auto_title),
        author: norm(author, row.auto_author),
      });
      const spine = () =>
        invoke("set_book_spine", { asin: row.asin, color, style, font, width });
      // A new picture also sets the spine colour from itself; let the
      // user's explicit colour win, else keep the one from the picture.
      if (upload && coverChoice === "upload") {
        if (color) {
          await invoke("set_book_cover", { asin: row.asin, data: upload.bytes });
          await spine();
        } else {
          await spine();
          await invoke("set_book_cover", { asin: row.asin, data: upload.bytes });
        }
      } else {
        if (coverChoice !== initialCover && coverChoice !== "upload") {
          await invoke("set_cover_source", { asin: row.asin, source: coverChoice });
        }
        await spine();
      }
      const newStatus = shelf === "auto" ? null : shelf;
      if (shelf !== initialShelf) {
        await invoke("set_book_status", { asin: row.asin, status: newStatus });
      }
      onSaved(shelf !== initialShelf ? newStatus : undefined);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await invoke("reset_book", { asin: row.asin });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const styleLabel: Record<SpineStyle, string> = {
    plain: t.stylePlain,
    cloth: t.styleCloth,
    leather: t.styleLeather,
    foil: t.styleFoil,
  };
  const fontLabel: Record<SpineFont, string> = { serif: t.fontSerif, sans: t.fontSans, caps: t.fontCaps };

  return (
    <div className="modal" onMouseDown={onClose}>
      <form
        className="editor editor--wide"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="editor__stage-col">
          <div
            className="editor__stage"
            onPointerDown={onStageDown}
            onPointerMove={onStageMove}
            onPointerUp={onStageUp}
            onPointerCancel={onStageUp}
            title={t.rotateHint}
          >
            <Book3D
              row={previewRow}
              look={look}
              mode="free"
              turn={turn}
              height={250}
              exactHeight
              coverTag={false}
              coverSrc={previewSrc}
            />
          </div>
          <div className="seg seg--sm editor__turns" role="group" aria-label={t.rotateHint}>
            <button type="button" className={`seg__btn${Math.abs(turn) < 5 ? " seg__btn--on" : ""}`} onClick={() => setTurn(0)}>
              {t.sectionSpine}
            </button>
            <button type="button" className={`seg__btn${Math.abs(turn + 32) < 5 ? " seg__btn--on" : ""}`} onClick={() => setTurn(-32)}>
              3D
            </button>
            <button type="button" className={`seg__btn${Math.abs(turn + 90) < 5 ? " seg__btn--on" : ""}`} onClick={() => setTurn(-90)}>
              {t.sectionCover}
            </button>
          </div>
          <p className="muted small editor__hint">{t.rotateHint}</p>
        </div>

        <div className="editor__fields">
          <h2 className="editor__heading">{t.customize}</h2>
          <label className="field">
            <span className="field__label">{t.fieldTitle}</span>
            <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">{t.fieldAuthor}</span>
            <input value={author} placeholder={t.noAuthor} onChange={(e) => setAuthor(e.target.value)} />
          </label>
          <p className="editor__orig muted small">
            {t.fromAmazon}: {row.original_title}
            {row.original_author ? ` · ${row.original_author}` : ""}
          </p>

          <fieldset className="editor__group">
            <legend>{t.sectionCover}</legend>
            <div className="seg" role="radiogroup" aria-label={t.sectionCover}>
              <button
                type="button"
                role="radio"
                aria-checked={coverChoice === "file"}
                className={`seg__btn${coverChoice === "file" ? " seg__btn--on" : ""}`}
                onClick={() => setCoverChoice("file")}
              >
                {t.coverFromFile}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={coverChoice === "type"}
                className={`seg__btn${coverChoice === "type" ? " seg__btn--on" : ""}`}
                onClick={() => {
                  setCoverChoice("type");
                  setTurn(-90);
                }}
              >
                <Icon name="text" size={15} />
                {t.coverTypographic}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={coverChoice === "upload"}
                className={`seg__btn${coverChoice === "upload" ? " seg__btn--on" : ""}`}
                onClick={() => (upload || hasCustomImage ? setCoverChoice("upload") : fileRef.current?.click())}
              >
                <Icon name="image" size={15} />
                {t.coverUpload}
              </button>
            </div>
            {coverChoice === "upload" && (
              <button type="button" className="linkbtn" onClick={() => fileRef.current?.click()}>
                {t.changeCover}…
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              hidden
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </fieldset>

          <fieldset className="editor__group">
            <legend>{t.sectionSpine}</legend>
            <div className="field__label">{t.spineColor}</div>
            <div className="swatches" role="radiogroup" aria-label={t.spineColor}>
              <button
                type="button"
                role="radio"
                aria-checked={color === null}
                className={`swatch swatch--auto${color === null ? " is-on" : ""}`}
                style={{ ["--c" as string]: row.auto_spine_color }}
                onClick={() => setColor(null)}
                title={t.spineAuto}
              >
                <span>{t.spineAuto}</span>
              </button>
              {SPINE_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={c}
                  className={`swatch${color === c ? " is-on" : ""}`}
                  style={{ ["--c" as string]: c }}
                  onClick={() => {
                    setColor(c);
                    setTurn((v) => (Math.abs(v + 90) < 20 ? -32 : v));
                  }}
                />
              ))}
              <label
                className={`swatch swatch--pick${color && !SPINE_SWATCHES.includes(color) ? " is-on" : ""}`}
                style={{ ["--c" as string]: color && !SPINE_SWATCHES.includes(color) ? color : "transparent" }}
                title={t.spineColor}
              >
                <input type="color" value={color ?? row.auto_spine_color} onChange={(e) => setColor(e.target.value)} />
                <Icon name="edit" size={13} />
              </label>
            </div>

            <div className="editor__row">
              <div>
                <div className="field__label">{t.spineStyle}</div>
                <div className="seg seg--sm" role="radiogroup" aria-label={t.spineStyle}>
                  {SPINE_STYLES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={style === s}
                      className={`seg__btn${style === s ? " seg__btn--on" : ""}`}
                      onClick={() => setStyle(s)}
                    >
                      {styleLabel[s]}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="field__label">{t.spineFont}</div>
                <div className="seg seg--sm" role="radiogroup" aria-label={t.spineFont}>
                  {SPINE_FONTS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      role="radio"
                      aria-checked={font === f}
                      className={`seg__btn spine-font--${f}${font === f ? " seg__btn--on" : ""}`}
                      onClick={() => setFont(f)}
                    >
                      {fontLabel[f]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="field__label">
              {t.spineWidth} · {width ?? autoW}px
            </div>
            <div className="editor__width">
              <input
                type="range"
                min={10}
                max={60}
                value={width ?? autoW}
                onChange={(e) => {
                  setWidth(Number(e.target.value));
                  setTurn((v) => (Math.abs(v + 90) < 20 ? -32 : v));
                }}
                aria-label={t.spineWidth}
              />
              <label className="check">
                <input type="checkbox" checked={width === null} onChange={(e) => setWidth(e.target.checked ? null : autoW)} />
                {t.widthAuto}
              </label>
            </div>
          </fieldset>

          <label className="field">
            <span className="field__label">{t.shelf}</span>
            <select className="field__select" value={shelf} onChange={(e) => setShelf(e.target.value as ReadStatus | "auto")}>
              <option value="auto">
                {t.statusAuto}
              </option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(t, s)}
                </option>
              ))}
            </select>
          </label>

          {error && <p className="editor__error small">{error}</p>}
          <div className="editor__actions">
            {(row.edited || upload) && (
              <button type="button" className="btn btn--ghost" onClick={reset} disabled={busy}>
                <Icon name="reset" size={16} />
                {t.resetBook}
              </button>
            )}
            <span className="editor__spacer" />
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              {t.cancel}
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {t.save}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
