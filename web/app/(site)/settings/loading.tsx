export default function Loading() {
  return (
    <main className="wrap narrow" aria-busy="true" aria-label="Loading">
      <div className="page-head">
        <div>
          <div className="sk" style={{ width: 120, height: 30 }} />
          <div className="sk" style={{ width: 320, maxWidth: "80vw", height: 14, marginTop: 12 }} />
        </div>
      </div>
      <div className="sk" style={{ height: 520, borderRadius: 14 }} />
      <div className="sk section" style={{ height: 300, borderRadius: 14 }} />
    </main>
  );
}
