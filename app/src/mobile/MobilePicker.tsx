import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { useMobileDismiss } from "./back";

export type MobilePickerOption<V extends string | number> = { value: V; label: string };

/** Android value trigger and modal option sheet, also usable inside another sheet. */
export function MobilePicker<V extends string | number>({ label, value, options, onChange }: {
  label: string; value: V; options: readonly MobilePickerOption<V>[]; onChange: (value: V) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  useMobileDismiss(open, () => setOpen(false), true);

  useEffect(() => {
    if (!open) return;
    const previous = trigger.current;
    const background = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute("data-mobile-picker"));
    const inert = background.map((el) => el.inert);
    background.forEach((el) => { el.inert = true; });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (list.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
    return () => {
      background.forEach((el, i) => { el.inert = inert[i]; });
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  return <>
    <button type="button" ref={trigger} className="mobile-picker__trigger" aria-label={`${label}: ${options.find((o) => o.value === value)?.label ?? ""}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}>
      <span>{options.find((o) => o.value === value)?.label}</span><Icon name="chevronDown" size={18} />
    </button>
    {open && createPortal(<div data-mobile-picker className="mobile-picker__backdrop" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <section className="mobile-picker__sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={(e) => {
        e.stopPropagation();
        const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "Tab") { e.preventDefault(); rows[(index + (e.shiftKey ? rows.length - 1 : 1)) % rows.length]?.focus(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          rows[e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : (index + (e.key === "ArrowUp" ? rows.length - 1 : 1)) % rows.length]?.focus();
        }
      }}>
        <div className="mobile-picker__handle" onPointerDown={(e) => { drag.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerUp={(e) => { if (drag.current !== null && e.clientY - drag.current > 70) setOpen(false); drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><span /></div>
        <h2 id={`${id}-title`}>{label}</h2>
        <div ref={list} id={id} role="listbox" aria-labelledby={`${id}-title`} className="mobile-picker__options">
          {options.map((option) => <button type="button" key={option.value} role="option" aria-selected={option.value === value} tabIndex={option.value === value ? 0 : -1} onClick={() => { setOpen(false); onChange(option.value); }}>
            <span>{option.label}</span>{option.value === value && <Icon name="check" size={22} />}
          </button>)}
        </div>
      </section>
    </div>, document.body)}
  </>;
}
