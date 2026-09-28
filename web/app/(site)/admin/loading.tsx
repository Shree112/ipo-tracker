export default function Loading() {
  return (
    <main className="wrap narrow" aria-busy="true" aria-label="Loading">
      <div className="page-head">
        <div>
          <div className="sk" style={{ width: 150, height: 30 }} />
          <div className="sk" style={{ width: 200, height: 14, marginTop: 12 }} />
        </div>
      </div>
      <div className="sk" style={{ height: 6, borderRadius: 999 }} />
      <div className="sk section" style={{ height: 150, borderRadius: 14 }} />
      <div className="sk section" style={{ height: 240, borderRadius: 14 }} />
    </main>
  );
}
