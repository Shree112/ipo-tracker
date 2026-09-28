import LegalPage, { contactEmail } from "@/components/LegalPage";

export const metadata = { title: "Terms of use" };

export default function Terms() {
  const email = contactEmail();
  return (
    <LegalPage title="Terms of use" updated="28 September 2026">
      <p>
        IPO Copilot is a free, personal, invite-only tool. By signing in you agree to the points below. Questions go to{" "}
        <a className="link" href={`mailto:${email}`}>{email}</a>.
      </p>
      <h2>Information only, not advice</h2>
      <p>
        IPO Copilot collects publicly available information about Indian mainboard IPOs and shows it in one place. It is
        not a SEBI-registered investment adviser or research analyst, and nothing here is a recommendation to apply for,
        buy or sell any security. Grey market premium (GMP) is an unofficial, unregulated quote and is often wrong. Make
        your own decisions and read the offer document.
      </p>
      <h2>No guarantees</h2>
      <p>
        Data can be late, incomplete or wrong, and emails can fail to arrive. The service is provided as it is, may change
        or stop at any time, and is not liable for any loss arising from its use.
      </p>
      <h2>Accounts</h2>
      <p>
        Accounts are approved by hand and places are limited. Access can be withdrawn at any time. Please don&apos;t share
        your account or try to copy the data in bulk.
      </p>
      <h2>Privacy</h2>
      <p>
        See the <a className="link" href="/privacy">privacy policy</a> for what is stored and how to delete it.
      </p>
    </LegalPage>
  );
}
