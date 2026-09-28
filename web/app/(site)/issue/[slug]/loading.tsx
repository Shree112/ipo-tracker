
// Rendered instantly on navigation while the page's data loads, so a tap
// from the list never feels dead.
export default function Loading() {
  return (
    <>
      <main className="wrap" aria-busy="true" aria-label="Loading">
        <div className="sk" style={{ width: 160, height: 14, marginTop: 26 }} />
        <div className="issue-head">
          <div className="issue-id">
            <div className="sk" style={{ width: 52, height: 52, borderRadius: 14 }} />
            <div>
              <div className="sk" style={{ width: 260, height: 28 }} />
              <div className="sk" style={{ width: 200, height: 14, marginTop: 10 }} />
            </div>
          </div>
        </div>
        <div className="sk" style={{ height: 96, borderRadius: 14 }} />
        <div className="sk section" style={{ height: 84, borderRadius: 14 }} />
        <div className="grid-main section">
          <div className="sk" style={{ height: 340, borderRadius: 14 }} />
          <div className="sk" style={{ height: 260, borderRadius: 14 }} />
        </div>
      </main>
    </>
  );
}
