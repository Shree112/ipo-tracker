import BrokerTest from "@/components/BrokerTest";
import { requireAdmin } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Broker links" };

export default async function BrokerLinksTest() {
  await requireAdmin();
  return (
    <main className="wrap narrow">
      <div className="page-head">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 style={{ marginTop: 10 }}>Broker links</h1>
          <p>
            Open this on an Android phone with the broker apps installed and tap each button. Note which letters open
            the app itself (not the Play Store or the website) for each broker.
          </p>
        </div>
      </div>
      <BrokerTest />
    </main>
  );
}
