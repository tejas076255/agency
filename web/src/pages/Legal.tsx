import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

// Public legal pages linked from the Google OAuth consent screen.
// NOTE: template text written for this project. Have it reviewed before a public launch.

const UPDATED = '21 November 2026';

function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link to="/login" className="text-sm text-slate-500 hover:text-slate-800">
        ← Agency Autopilot
      </Link>
      <h1 className="mt-4 text-3xl font-bold">{title}</h1>
      <p className="mt-1 text-sm text-slate-500">Last updated: {UPDATED}</p>
      <div className="mt-8 space-y-6 leading-relaxed text-slate-700 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-900 [&_li]:ml-5 [&_li]:list-disc">
        {children}
      </div>
    </main>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy">
      <p>
        Agency Autopilot (“we”, “the app”) helps digital marketing agencies monitor their clients’
        websites and send monthly reports. This policy explains what data we access, why, and how it
        is protected.
      </p>

      <h2>Data we collect</h2>
      <ul>
        <li>Your Google account name, email and profile picture when you sign in with Google.</li>
        <li>Agency details you enter: agency name, brand color and logo.</li>
        <li>Client details you enter: business name, website URL and contact email.</li>
        <li>
          Activity logs (for example “client added”) with a salted hash of the IP address, never the
          raw IP.
        </li>
      </ul>

      <h2>Google user data we access</h2>
      <p>Only after an agency user or their client explicitly connects a Google account:</p>
      <ul>
        <li>
          <b>Search Console (read-only)</b>: clicks, impressions, average position, top queries and
          pages.
        </li>
        <li>
          <b>Google Analytics 4 (read-only)</b>: list of properties, sessions, users, engagement and
          key events.
        </li>
        <li>
          <b>Google Slides and Drive (only files created by the app)</b>: to create the monthly
          report and export it as PDF.
        </li>
        <li>
          <b>Gmail (send only)</b>: to email the monthly report from the agency’s own Gmail. We
          cannot read any email.
        </li>
        <li>
          <b>Google Business Profile</b> (optional): listing details, performance (calls, direction
          requests, website clicks), and reviews; and posting review replies when the agency writes
          one.
        </li>
        <li>
          <b>Google Ads (read-only use)</b> (optional): campaign performance, spend and search
          terms.
        </li>
        <li>
          <b>YouTube (read-only)</b> (optional): channel details and channel analytics, connected by
          the channel owner.
        </li>
        <li>
          <b>Google Sheets / Drive (files created by the app)</b>: exporting data to a spreadsheet
          in the agency’s Drive.
        </li>
      </ul>
      <p>
        Review text may be analysed by the Google Cloud Natural Language API to estimate sentiment.
        Competitor ratings are fetched live from Google Places and are not stored; only place IDs
        are saved.
      </p>
      <p>
        Agency Autopilot’s use and transfer of information received from Google APIs adheres to the{' '}
        <a
          className="text-blue-700 underline"
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noreferrer"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. Google user data is used only to provide the
        reporting features you see in the app. It is not sold, not used for advertising and not used
        to train AI models.
      </p>

      <h2>AI processing</h2>
      <p>
        To write the weekly summary and action items, a compact summary of metrics (numbers, page
        paths and search queries, not personal data) is processed by Cloudflare Workers AI. The
        output is stored with the health check.
      </p>

      <h2>How data is stored and protected</h2>
      <ul>
        <li>Data is stored on Cloudflare (D1 database, KV storage).</li>
        <li>
          Google refresh tokens are encrypted with AES-256-GCM; keys are kept as server secrets.
        </li>
        <li>Each agency can only access its own data.</li>
        <li>Sessions use secure, HttpOnly cookies and expire after 7 days.</li>
      </ul>

      <h2>Sharing</h2>
      <p>
        Reports are shared only with the recipients the agency chooses (email and read-only share
        links). We use Cloudflare and Google as infrastructure providers. We do not sell data.
      </p>

      <h2>Retention and deletion</h2>
      <ul>
        <li>
          Deleting a client deletes its health checks, insights, reports and Google connection.
        </li>
        <li>
          Disconnecting a Google account revokes the token at Google and deletes our encrypted copy.
        </li>
        <li>
          You can also revoke access any time at{' '}
          <a
            className="text-blue-700 underline"
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
          >
            myaccount.google.com/permissions
          </a>
          .
        </li>
        <li>To delete your agency account entirely, contact us at the email below.</li>
      </ul>

      <h2>Contact</h2>
      <p>
        Questions or deletion requests: use the developer contact email shown on the Google sign-in
        screen.
      </p>
    </LegalLayout>
  );
}

export function TermsPage() {
  return (
    <LegalLayout title="Terms of Service">
      <p>By using Agency Autopilot you agree to these terms.</p>
      <h2>The service</h2>
      <p>
        Agency Autopilot provides website health checks, AI-generated recommendations and automated
        reports for digital marketing agencies. The service is currently in development/testing and
        is provided “as is”.
      </p>
      <h2>Your responsibilities</h2>
      <ul>
        <li>
          Only connect Google accounts and properties you or your clients are authorised to access.
        </li>
        <li>
          Make sure you have your clients’ permission to analyse their data and email them reports.
        </li>
        <li>Keep your Google account secure; you are responsible for activity in your agency.</li>
      </ul>
      <h2>Recommendations are not guarantees</h2>
      <p>
        Health scores and AI recommendations are estimates based on available data. They are not
        guarantees of rankings, traffic or revenue. Review recommendations before acting on them.
      </p>
      <h2>Availability and changes</h2>
      <p>
        We may change or discontinue features. Google and Cloudflare services, quotas and approvals
        can affect what the app can do.
      </p>
      <h2>Limitation of liability</h2>
      <p>
        To the extent permitted by law, we are not liable for indirect or consequential losses
        arising from use of the app.
      </p>
      <h2>Contact</h2>
      <p>Use the developer contact email shown on the Google sign-in screen.</p>
    </LegalLayout>
  );
}
