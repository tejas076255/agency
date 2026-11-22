"""Builds docs/USER_GUIDE.pdf. Usage: python scripts/build_user_guide.py docs/USER_GUIDE.pdf  (needs: pip install reportlab)"""
import sys
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether, ListFlowable, ListItem, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

OUT = sys.argv[1]
URL = "https://agency-autopilot.invoice-to-excel.workers.dev"
BRAND = colors.HexColor("#4f46e5")
INK = colors.HexColor("#0f172a")
MUTED = colors.HexColor("#475569")
LINE = colors.HexColor("#e2e8f0")
TINT = colors.HexColor("#eef2ff")
WARN_BG = colors.HexColor("#fffbeb")
WARN_LINE = colors.HexColor("#f59e0b")

ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=INK, spaceBefore=14, spaceAfter=8, keepWithNext=1)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=BRAND, spaceBefore=10, spaceAfter=4, keepWithNext=1)
BODY = ParagraphStyle("Body", parent=ss["BodyText"], fontName="Helvetica", fontSize=10, leading=14.5, textColor=INK, spaceAfter=5)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=8.5, leading=12, textColor=MUTED)
CELL = ParagraphStyle("Cell", parent=BODY, fontSize=9, leading=12, spaceAfter=0)
CELLB = ParagraphStyle("CellB", parent=CELL, fontName="Helvetica-Bold")
TITLE = ParagraphStyle("Title", parent=H1, fontSize=30, leading=36, alignment=TA_CENTER, spaceAfter=10)
SUB = ParagraphStyle("Sub", parent=BODY, fontSize=13, leading=18, alignment=TA_CENTER, textColor=MUTED)


def p(text, style=BODY):
    return Paragraph(text, style)


def bullets(items, numbered=False):
    return ListFlowable(
        [ListItem(p(i), leftIndent=12) for i in items],
        bulletType="1" if numbered else "bullet",
        start="1" if numbered else None,
        bulletFontSize=9 if not numbered else 10,
        leftIndent=14,
        bulletColor=BRAND,
    )


def steps(items):
    return bullets(items, numbered=True)


def table(rows, widths, header=True):
    data = [[p(c, CELLB if (header and r == 0) else CELL) for c in row] for r, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        style.append(("BACKGROUND", (0, 0), (-1, 0), TINT))
    t.setStyle(TableStyle(style))
    return t


def note(text, kind="tip"):
    bg, line, label = (TINT, BRAND, "Tip") if kind == "tip" else (WARN_BG, WARN_LINE, "Important")
    t = Table([[p(f"<b>{label}:</b> {text}", CELL)]], colWidths=[170 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 3, line),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return KeepTogether([Spacer(1, 3), t, Spacer(1, 6)])


def on_page(c, doc):
    if doc.page == 1:
        return
    c.saveState()
    c.setStrokeColor(LINE)
    c.line(20 * mm, 15 * mm, 190 * mm, 15 * mm)
    c.setFont("Helvetica", 8)
    c.setFillColor(MUTED)
    c.drawString(20 * mm, 10 * mm, "Agency Autopilot - User Guide")
    c.drawRightString(190 * mm, 10 * mm, f"Page {doc.page}")
    c.restoreState()


story = []

# ---------------- Cover ----------------
story += [
    Spacer(1, 55 * mm),
    p("Agency Autopilot", TITLE),
    p("User Guide", SUB),
    Spacer(1, 6),
    p("How to set up your agency, connect clients, read health checks, and send monthly reports", SUB),
    Spacer(1, 18 * mm),
    p(f'App: <link href="{URL}" color="#4f46e5">{URL}</link>', ParagraphStyle("c", parent=BODY, alignment=TA_CENTER)),
    p("Version: November 2026 (Phases 1-3 and Phase 4 plans)", ParagraphStyle("c2", parent=SMALL, alignment=TA_CENTER)),
    PageBreak(),
]

# ---------------- Contents ----------------
story += [p("Contents", H1)]
contents = [
    "1. What Agency Autopilot does",
    "2. What works today (feature status)",
    "3. Sign in and create your agency",
    "4. Settings: branding, Google account for reports, report email, team",
    "5. Add a client and connect their Google account",
    "6. Run a health check and read the results",
    "7. The weekly action plan (AI)",
    "8. Monthly reports: preview, edit, send, share",
    "9. Local SEO, reviews and competitors",
    "10. Google Ads, YouTube and Sheets export",
    "11. Agency pages: Overview, Local SEO, Advertising, YouTube, Reports, Job logs, Plan",
    "12. Team members",
    "13. What runs automatically",
    "14. Troubleshooting",
    "15. Good habits and security",
]
story += [p(c) for c in contents]
story.append(PageBreak())

# ---------------- 1 ----------------
story += [
    p("1. What Agency Autopilot does", H1),
    p("Agency Autopilot helps a digital marketing agency look after many clients without checking every Google tool by hand. "
      "You connect each client's Google accounts once. After that the app:"),
    bullets([
        "runs a <b>weekly health check</b> of each client's website (search traffic, website traffic and speed),",
        "gives every client a <b>health score from 0 to 100</b>,",
        "writes a <b>plan of 5 actions for the week</b>, with the reason and expected impact for each,",
        "creates a <b>branded monthly PDF report</b> and emails it to the client from your Gmail,",
        "optionally tracks <b>Google Business Profile, reviews, competitors, Google Ads and YouTube</b>.",
    ]),
    p("All times in the app are shown in Indian Standard Time (IST) and numbers use Indian grouping (1,23,456)."),
]

# ---------------- 2 ----------------
story += [
    p("2. What works today (feature status)", H1),
    p("Some Google features need approval or billing from Google before they return real data. Until then the app shows a clear "
      "message such as <i>\"not configured\"</i> or <i>\"not approved yet\"</i>. It never shows fake numbers."),
    table([
        ["Feature", "Status", "What is needed"],
        ["Sign in, agency, clients, team, plans", "Ready", "Nothing"],
        ["Website speed (PageSpeed) and AI action plan", "Ready, tested live", "Nothing"],
        ["Search Console and Google Analytics 4", "Ready, needs your first real test", "Client connects their Google account"],
        ["Monthly report (Slides, PDF, Gmail)", "Ready, needs your first real test", "Connect the agency Google account in Settings"],
        ["YouTube", "Ready, not yet tested live", "Channel owner connects; YouTube APIs enabled"],
        ["Google Business Profile and reviews", "Built, waiting for Google", "Google must approve Business Profile API access"],
        ["Competitors (Places)", "Built, waiting for setup", "Billing on Google Cloud + PLACES_API_KEY"],
        ["Review sentiment", "Built, waiting for setup", "Billing on Google Cloud + NATURAL_LANGUAGE_API_KEY"],
        ["Google Ads", "Built, waiting for setup", "Explorer access for the app's Google Cloud project"],
        ["Online payments for plans", "Not built", "Owner must choose a payment provider first"],
    ], [62 * mm, 46 * mm, 62 * mm]),
    note("While the Google sign-in app is in <b>Testing</b> mode, only Google accounts added as <b>Test users</b> in Google Cloud "
         "can sign in or connect, and Google asks clients to reconnect about every 7 days.", "warn"),
    PageBreak(),
]

# ---------------- 3 ----------------
story += [
    p("3. Sign in and create your agency", H1),
    steps([
        f"Open <b>{URL}</b>.",
        "Wait for the small security check (Turnstile) to show a tick, then click <b>Sign in with Google</b>.",
        "Choose your Google account. If Google says <i>\"Google hasn't verified this app\"</i>, click <b>Continue</b> "
        "(normal while the app is in testing).",
        "On first sign-in, type your <b>agency name</b> and choose a <b>brand color</b>, then click <b>Continue</b>.",
        "Optionally upload your <b>logo</b> (PNG, JPEG or WebP, up to 512 KB; square logos look best).",
        "Click <b>Go to dashboard</b> (or <b>Skip for now</b>).",
    ]),
    note("Your agency name, color and logo appear on client reports and emails, so set them before sending the first report."),
]

# ---------------- 4 ----------------
story += [
    p("4. Settings", H1),
    p("Open <b>Settings</b> from the top menu. Only the agency <b>owner</b> can change these settings.", BODY),
    p("Agency branding and logo", H2),
    p("Change the agency name, brand color and logo at any time. Click <b>Save changes</b>."),
    p("Reports: agency Google account (needed for reports and Sheets)", H2),
    steps([
        "Click <b>Connect Google account</b>.",
        "Sign in with the Google account the agency sends reports from.",
        "Allow all three permissions: Google Slides, Drive files created by this app, and sending email.",
    ]),
    p("The app can only see files it creates in your Drive. It cannot read your emails; it can only send the report emails."),
    p("Report email", H2),
    p("Set the email <b>subject</b> and <b>message</b> used for every monthly report. You can use the placeholders "
      "<b>{client}</b>, <b>{month}</b> and <b>{agency}</b>. You can also CC your agency Gmail and include the Hinglish summary."),
    p("Team, account and activity log", H2),
    bullets([
        "<b>Team</b>: invite colleagues (see section 12).",
        "<b>Log out of all devices</b>: signs you out everywhere at once, useful if you lose a phone or laptop.",
        "<b>Activity log</b> (owner only): who added clients, connected accounts, sent reports and more.",
    ]),
    PageBreak(),
]

# ---------------- 5 ----------------
story += [
    p("5. Add a client and connect their Google account", H1),
    p("Add the client", H2),
    steps([
        "Go to <b>Clients</b> and click <b>+ Add client</b>.",
        "Enter the business name, the website URL (for example https://example.com) and the client's email address.",
        "Tick <b>Auto-send monthly report</b> if the report should be emailed automatically on the 1st of each month. "
        "If you leave it off, the report is prepared for you to check and send yourself.",
        "Click <b>Add client</b>.",
    ]),
    p("Connect Search Console and Google Analytics", H2),
    steps([
        "Open the client and click <b>Connect Google</b>.",
        "Sign in with the Google account that has access to the client's <b>Search Console</b> and <b>Google Analytics 4</b> "
        "(this can be the client's account or your account if the client gave you access).",
        "Allow access (read-only).",
        "Back in the app, choose the <b>Search Console site</b> and the <b>GA4 property</b> from the lists and click <b>Save</b>.",
    ]),
    note("If a list is empty, that Google account has no access to Search Console or GA4 for the site. Ask the client to add the "
         "account as a user in Search Console / GA4, then connect again."),
    note("If the client later removes access, the client shows a red <b>Reconnect needed</b> banner. Click <b>Reconnect Google</b> "
         "to fix it.", "warn"),
]

# ---------------- 6 ----------------
story += [
    p("6. Run a health check and read the results", H1),
    p("Health checks run automatically every Monday at 6:00 AM IST. To run one now, open the client and click "
      "<b>Run health check</b>. It usually takes 1-2 minutes; the page refreshes by itself."),
    p("Health score (0-100)", H2),
    table([
        ["Part of the score", "Weight", "What it looks at"],
        ["Search performance", "35", "Search clicks and impressions trend, average Google position, click-through rate"],
        ["Organic traffic", "30", "Organic visits trend, engagement rate, key events (leads) trend"],
        ["Website performance", "25", "Mobile and desktop speed scores, Core Web Vitals from real users"],
        ["Data completeness", "10", "How many of Search Console, Analytics and PageSpeed are connected"],
    ], [48 * mm, 18 * mm, 104 * mm]),
    p("A green score is 75 or more, amber is 50-74 and red is below 50. If some data is missing, the score is calculated from what "
      "is available, and the missing parts are listed on the page.", SMALL),
    p("What you see on the client page", H2),
    bullets([
        "<b>Key numbers</b>: clicks, impressions, average position, organic and all sessions, users, leads, engagement. "
        "Green and red arrows compare the last 28 days with the 28 days before.",
        "<b>Speed</b>: the <i>lab test</i> is a fresh test by Google right now; <i>real users</i> is what visitors experienced over the "
        "last 28 days. Core Web Vitals show <b>passed</b> or <b>failed</b>.",
        "<b>Charts</b>: daily search clicks, daily sessions and the mobile speed score over time.",
        "<b>Quick-win keywords</b>: searches where the site is on page 2 (positions 8-20); a small improvement can bring them to page 1.",
        "<b>Pages losing clicks</b>, <b>top queries</b>, <b>top pages</b>, <b>traffic channels</b> and <b>landing pages</b>.",
    ]),
    note("A yellow box with warnings means part of the check failed (for example GA4 not connected). The rest of the results are still saved."),
    PageBreak(),
]

# ---------------- 7 ----------------
story += [
    p("7. The weekly action plan (AI)", H1),
    p("After each health check the app writes a short summary and <b>exactly 5 actions</b>, numbered by priority. Each action shows:"),
    bullets([
        "<b>What to do</b> and a short description,",
        "<b>Why</b> (based on the client's data),",
        "<b>Expected impact</b> (an estimate, never a guarantee),",
        "<b>Supporting metrics</b>: the exact numbers from the data that support the action.",
    ]),
    p("Use the <b>English / Hinglish</b> switch to read the summary in Hinglish. Tick the checkbox next to an action when it is done; "
      "the counter shows your progress."),
    note("If the AI service is unavailable, the app still creates 5 actions using fixed rules from the data and shows a small notice. "
         "Always review recommendations before acting on them."),
]

# ---------------- 8 ----------------
story += [
    p("8. Monthly reports", H1),
    p("Before the first report, connect the agency Google account in Settings (section 4)."),
    p("Create and check a report", H2),
    steps([
        "Open the client and scroll to <b>Monthly reports</b>.",
        "Click <b>Generate preview now</b>. After about a minute the report appears with status <b>Ready to send</b>.",
        "Click <b>Preview PDF</b> to check it.",
        "Optional: click <b>Edit in Google Slides</b>, make changes in Slides, then come back and click <b>Re-export PDF</b>.",
        "Click <b>Send to client</b>. The email (with the PDF attached and a link to the online report) goes from your Gmail.",
    ]),
    p("Share link and automatic sending", H2),
    bullets([
        "<b>Copy share link</b> gives a read-only web page of the report. The client does not need to sign in.",
        "On the 1st of every month at 6:00 AM IST, reports for the previous month are created for every connected client. "
        "Clients with <b>Auto-send</b> get the email automatically; others wait for you on the <b>Reports</b> page.",
    ]),
    note("Logo and chart images in the Slides report only appear on the live website, not when running the app on your own computer."),
    PageBreak(),
]

# ---------------- 9 ----------------
story += [
    p("9. Local SEO, reviews and competitors", H1),
    note("Business Profile data only works after Google approves Business Profile API access for the app. Until then the tab "
         "shows a \"not approved\" message.", "warn"),
    p("Connect Google Business Profile", H2),
    steps([
        "Open the client and choose the <b>Local SEO &amp; reviews</b> tab.",
        "Click <b>Connect</b> and sign in with a Google account that manages the business listing.",
        "Choose the business location from the list and click <b>Save</b>.",
        "Run a health check (Overview tab). Data syncs with every health check.",
    ]),
    p("What you get", H2),
    bullets([
        "Profile views, calls, direction requests and website clicks, compared with the previous 28 days.",
        "Listing details with <b>Missing</b> warnings (for example no opening hours or website).",
        "<b>Reviews</b>: star rating, text, date and reply status. Click <b>Reply</b> to post a reply on Google.",
        "<b>Sentiment</b> (positive / neutral / negative), common complaints, what customers like, and reviews per month. "
        "Sentiment is AI-derived and kept separate from the original review.",
    ]),
    p("Competitors", H2),
    steps([
        "In <b>Competitors</b>, search for businesses, for example \"dentist in Kothrud Pune\".",
        "Click <b>This is my client</b> for the client's own listing and <b>Track competitor</b> for others (up to 10).",
        "The table ranks everyone by rating. Ratings are loaded live from Google each time and are not stored.",
    ]),
]

# ---------------- 10 ----------------
story += [
    p("10. Google Ads, YouTube and Sheets export", H1),
    p("Google Ads", H2),
    p("On the <b>Google Ads</b> tab, click <b>Connect</b>, sign in with an account that can see the client's Ads account, and choose the "
      "account. You will see spend, clicks, conversions, cost per conversion, ROAS (only if conversion values are tracked), daily "
      "spend, campaigns with budget use, and <b>wasted search terms</b> (searches that cost money but brought no conversions)."),
    note("Reading real Ads accounts needs the app's Google Cloud project to have Explorer access (enough for read-only reporting).", "warn"),
    p("YouTube", H2),
    p("On the <b>YouTube</b> tab, the <b>channel owner</b> clicks <b>Connect</b> and chooses the channel. You will see views, watch time, "
      "net subscribers, average view duration, daily views and the top videos of the last 28 days."),
    p("Export to Google Sheets", H2),
    p("On the <b>Exports</b> tab click <b>Export now</b>. A formatted spreadsheet is created in the agency's Google Drive with the data "
      "that is available (search, Analytics, Business Profile, reviews, Ads, YouTube). Columns made by AI are labelled \"AI-derived\"."),
    PageBreak(),
]

# ---------------- 11 ----------------
story += [
    p("11. Agency pages (top menu)", H1),
    table([
        ["Page", "What it is for"],
        ["Overview", "Agency summary: number of clients, average score, clients that need attention, recent jobs, reports waiting to be sent"],
        ["Clients", "All clients with score, trend arrow and status; search box; add new clients"],
        ["Local SEO", "Calls, directions, views, rating, negative and unanswered reviews for every client with Business Profile"],
        ["Advertising", "Spend, conversions, ROAS and wasted spend for every client with Google Ads"],
        ["YouTube", "Views and subscriber growth for every client with YouTube"],
        ["Reports", "All monthly reports; filter by Ready to send, Sent or Failed"],
        ["Job logs", "Every health check and report job with status and errors; Run now buttons; API usage for the last 7 days"],
        ["Plan", "Your plan, limits and usage (clients, team members, manual runs per day)"],
        ["Settings", "Branding, Google account for reports, report email, team, account, activity log"],
    ], [32 * mm, 138 * mm]),
    p("Plans", H2),
    table([
        ["Plan", "Clients", "Team members", "Manual runs per day"],
        ["Free", "5", "1 (owner only)", "30"],
        ["Pro", "25", "5", "200"],
        ["Agency", "100", "20", "1,000"],
    ], [40 * mm, 35 * mm, 50 * mm, 45 * mm]),
    p("Prices on the Plan page are indicative only. Online payment is not connected yet, so nothing is charged.", SMALL),
]

# ---------------- 12 ----------------
story += [
    p("12. Team members", H1),
    p("Team members need the Pro or Agency plan (the Free plan allows only the owner)."),
    steps([
        "Owner: go to <b>Settings &gt; Team</b>, type the colleague's Gmail address and click <b>Invite</b>.",
        "The invite is emailed from the agency Gmail (if connected). You also get a link you can share on WhatsApp.",
        "The colleague opens the link and signs in with <b>the same Gmail address</b> that was invited. The link works for 7 days.",
        "Owner: open a client, click <b>Edit</b>, and choose the member under <b>Assigned team member</b>.",
    ]),
    p("Members only see the clients assigned to them. Only the owner can change settings, invite or remove people. Removing a member "
      "signs them out immediately and unassigns their clients."),
    PageBreak(),
]

# ---------------- 13 ----------------
story += [
    p("13. What runs automatically", H1),
    table([
        ["When (IST)", "What happens"],
        ["Every Monday, 6:00 AM", "Health check for every client: Search Console, Analytics, speed, plus Business Profile, reviews, Ads and YouTube if connected; new score and 5 actions"],
        ["1st of every month, 6:00 AM", "Monthly report for the previous month for every connected client; emailed if Auto-send is on"],
        ["Any time", "Run now from a client page or Job logs; reports can be generated with Generate preview now"],
    ], [48 * mm, 122 * mm]),
    p("If a Google service is busy, the app retries automatically. One client failing never stops the others; check <b>Job logs</b> for details."),
]

# ---------------- 14 ----------------
story += [
    p("14. Troubleshooting", H1),
    table([
        ["Problem", "What to do"],
        ["\"Access blocked\" or cannot sign in", "Add the Google account under Test users in Google Cloud (Google Auth Platform > Audience)"],
        ["\"Google hasn't verified this app\"", "Click Continue. Normal while the app is in testing"],
        ["Search Console or GA4 list is empty", "That Google account has no access. Ask the client to add it as a user, then connect again"],
        ["Client shows \"Reconnect needed\"", "Click Reconnect Google on the client page (in testing mode this happens about every 7 days)"],
        ["Report says \"Connect your agency Google account\"", "Settings > Reports: agency Google account > Connect"],
        ["Business Profile says \"not approved\"", "Google has not approved Business Profile API access yet; wait for approval"],
        ["Competitors / sentiment say \"not configured\"", "The Places / Natural Language API key has not been added yet"],
        ["Google Ads says \"Test access\" / not approved", "Apply for Explorer access: Google Cloud Console > Google Ads API > Overview"],
        ["\"Your plan allows ...\" message", "You reached a plan limit; contact the app operator to change the plan"],
        ["\"Invalid or missing CSRF token\"", "Refresh the page and try again"],
        ["A job failed", "Open Job logs, read the error, fix the cause, then click Run now"],
        ["Invite does not work", "Sign in with exactly the invited Gmail address; ask for a new invite if 7 days have passed"],
    ], [62 * mm, 108 * mm]),
]

# ---------------- 15 ----------------
story += [
    p("15. Good habits and security", H1),
    bullets([
        "Never share passwords, API keys or secrets in chats or emails.",
        "Only connect Google accounts and businesses you or your clients are allowed to access, and get the client's permission "
        "before emailing them reports.",
        "Review the AI action plan before acting on it: it is a suggestion based on data, not a guarantee.",
        "Check the report preview before sending, especially the first time for each client.",
        "Use <b>Log out of all devices</b> if a phone or laptop is lost.",
        "The owner can see every important action in the <b>Activity log</b>.",
    ]),
    Spacer(1, 10),
    p("Technical documentation for setup, deployment and Google API approvals is in the project files README.md, PROJECT_STATUS.md "
      "and the docs folder.", SMALL),
]

# Keep only the page breaks after the cover and the contents; let sections flow.
_seen = 0
_flow = []
for _f in story:
    if isinstance(_f, PageBreak):
        _seen += 1
        if _seen > 2:
            continue
    _flow.append(_f)
story = _flow

doc = SimpleDocTemplate(
    OUT, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=22 * mm,
    title="Agency Autopilot - User Guide", author="Agency Autopilot", subject="How to use Agency Autopilot",
)
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print("written", OUT)
