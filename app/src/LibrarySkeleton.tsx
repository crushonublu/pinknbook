/**
 * Placeholders shown while the library is first read at start-up, so the
 * "no books yet" screen never flashes before the books appear. `home` mirrors
 * the phone's Home (streak card, the book being read, a shelf); `grid` a
 * page of covers.
 */
export function LibrarySkeleton({ kind, label }: { kind: "home" | "grid"; label: string }) {
  return (
    <div className={`libskel libskel--${kind}`} role="status" aria-busy="true" aria-label={label}>
      {kind === "home" ? (
        <>
          <div className="libskel__block libskel__streak" />
          <div className="libskel__block libskel__continue">
            <span className="libskel__cover" />
            <span className="libskel__lines"><i /><i /><i /></span>
          </div>
          <i className="libskel__heading" />
          <div className="libskel__row">
            {[0, 1, 2, 3].map((i) => <span key={i} className="libskel__cover" />)}
          </div>
        </>
      ) : (
        <div className="libskel__grid">
          {Array.from({ length: 12 }, (_, i) => <span key={i} className="libskel__cover" />)}
        </div>
      )}
    </div>
  );
}
