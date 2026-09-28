// Home skeleton: shown the instant a link is tapped, under the header that
// stays in place.
export default function Loading() {
  return (
    <main className="wrap" aria-busy="true" aria-label="Loading">
      <div className="page-head">
        <div>
          <div className="sk" style={{ width: 180, height: 30 }} />
          <div className="sk" style={{ width: 340, maxWidth: "80vw", height: 14, marginTop: 12 }} />
        </div>
      </div>
      <div className="sk" style={{ width: 420, maxWidth: "100%", height: 40, borderRadius: 12 }} />
      <div className="list" style={{ marginTop: 16 }}>
        {Array.from({ length: 5 }, (_, k) => (
          <div key={k} className="list-row">
            <div className="co">
              <div className="sk" style={{ width: 36, height: 36, borderRadius: 10 }} />
              <div className="sk" style={{ width: 160, height: 16 }} />
            </div>
            <div className="sk" style={{ height: 16 }} />
            <div className="sk" style={{ height: 16 }} />
            <div className="sk" style={{ height: 16 }} />
            <div className="sk" style={{ height: 16 }} />
          </div>
        ))}
      </div>
    </main>
  );
}
