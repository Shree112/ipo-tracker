import LegalPage, { contactEmail } from "@/components/LegalPage";

export const metadata = { title: "Privacy policy" };

export default function Privacy() {
  const email = contactEmail();
  return (
    <LegalPage title="Privacy policy" updated="28 September 2026">
      <p>
        IPO Copilot is a small, invite-only tool that sends a daily email about Indian mainboard IPOs. This page
        explains what it stores about you and why. It is run by one person, reachable at{" "}
        <a className="link" href={`mailto:${email}`}>{email}</a>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <b>From Google sign-in:</b> your name, email address and Google account ID. Nothing else is requested: no
          contacts, calendar, Drive or Gmail access.
        </li>
        <li>
          <b>What you set up here:</b> your alert rules, digest time and days, an optional alternative email address, and
          the IPOs you mark as applied or skipped (with any note you add).
        </li>
        <li>
          <b>Activity records:</b> when you signed up, when you were last seen, and which digests were sent to you and
          when.
        </li>
      </ul>

      <h2>How it is used</h2>
      <ul>
        <li>To sign you in and to let the admin approve your account.</li>
        <li>To decide which IPOs match your alerts and to email you your digest and reminders.</li>
        <li>To show your applied/skipped marks back to you on the site.</li>
      </ul>
      <p>
        Your data is not sold, not shared with advertisers, not used for advertising, and not used to train any model.
        Information from Google is used only to sign you in and to address your emails, in line with the{" "}
        <a className="link" href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
          Google API Services User Data Policy
        </a>
        , including its Limited Use requirements.
      </p>

      <h2>Where it is stored</h2>
      <p>
        The database and sign-in run on Supabase (Singapore region), the website on Vercel, and the scheduled jobs on
        GitHub Actions. Digest emails are sent through Gmail. These services process data only to run IPO Copilot.
      </p>

      <h2>Cookies</h2>
      <p>One sign-in cookie keeps you logged in. There are no analytics, tracking or advertising cookies.</p>

      <h2>Keeping and deleting your data</h2>
      <p>
        Your data is kept while you have an account. You can pause emails at any time on the Alerts page. To delete your
        account and everything linked to it, email <a className="link" href={`mailto:${email}`}>{email}</a> and it will be
        removed within 30 days. You can also remove IPO Copilot&apos;s access from your Google account settings.
      </p>

      <h2>Market data</h2>
      <p>
        IPO details, grey market premium (GMP) and subscription figures are collected from public websites. GMP is an
        unofficial grey-market quote. Nothing on this site or in the emails is investment advice.
      </p>

      <h2>Changes</h2>
      <p>If this policy changes, the date at the top changes too, and significant changes are mentioned in the digest.</p>
    </LegalPage>
  );
}
