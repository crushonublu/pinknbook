/**
 * An on/off switch. Put it inside the `<label>` that names it: the whole row
 * then toggles it, and screen readers read it as a switch.
 */
export function Switch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <span className="scx-switch">
      <input className="scx-switch__input" type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="scx-switch__track" aria-hidden="true" />
    </span>
  );
}
