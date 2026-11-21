// Google Slides, Drive and Gmail calls used to build and send the monthly report.
import { bytesToBase64, randomToken } from '../lib/crypto';
import { googleRequest, GoogleApiError } from './http';

const SLIDES = 'https://slides.googleapis.com/v1/presentations';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

// Placeholders used in the report template. Image placeholders are shapes containing the token.
export const PLACEHOLDERS = {
  text: [
    'AGENCY_NAME',
    'CLIENT_NAME',
    'MONTH',
    'SCORE',
    'CLICKS',
    'CLICKS_CHANGE',
    'SESSIONS',
    'SESSIONS_CHANGE',
    'KEY_EVENTS',
    'MOBILE_SPEED',
    'DESKTOP_SPEED',
    'AVG_POSITION',
    'SUMMARY',
    'ACTIONS',
    'REPORT_LINK',
  ],
  image: ['LOGO', 'CHART_CLICKS', 'CHART_SESSIONS'],
} as const;

/** Object IDs of the colored header bars; recolored with the agency brand color on every copy. */
export const HEADER_IDS = ['aa_hdr_1', 'aa_hdr_2', 'aa_hdr_3'];

type Rgb = { red: number; green: number; blue: number };
export function hexToRgbFloat(hex: string): Rgb {
  const v = parseInt(hex.replace('#', ''), 16);
  return { red: ((v >> 16) & 255) / 255, green: ((v >> 8) & 255) / 255, blue: (v & 255) / 255 };
}

const pt = (n: number) => ({ magnitude: n, unit: 'PT' });

function box(
  id: string,
  page: string,
  x: number,
  y: number,
  w: number,
  h: number,
  shape = 'TEXT_BOX',
) {
  return {
    createShape: {
      objectId: id,
      shapeType: shape,
      elementProperties: {
        pageObjectId: page,
        size: { width: pt(w), height: pt(h) },
        transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'PT' },
      },
    },
  };
}

function text(id: string, value: string, size: number, opts: { bold?: boolean; color?: Rgb } = {}) {
  return [
    { insertText: { objectId: id, text: value } },
    {
      updateTextStyle: {
        objectId: id,
        style: {
          fontSize: pt(size),
          bold: opts.bold ?? false,
          fontFamily: 'Arial',
          foregroundColor: {
            opaqueColor: { rgbColor: opts.color ?? { red: 0.12, green: 0.16, blue: 0.23 } },
          },
        },
        fields: 'fontSize,bold,fontFamily,foregroundColor',
      },
    },
  ];
}

function header(id: string, page: string, title: string) {
  return [
    box(id, page, 0, 0, 720, 64, 'RECTANGLE'),
    {
      updateShapeProperties: {
        objectId: id,
        shapeProperties: {
          shapeBackgroundFill: { solidFill: { color: { rgbColor: hexToRgbFloat('#4f46e5') } } },
          outline: { propertyState: 'NOT_RENDERED' },
        },
        fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState',
      },
    },
    box(`${id}_t`, page, 32, 14, 520, 40),
    ...text(`${id}_t`, title, 22, { bold: true, color: { red: 1, green: 1, blue: 1 } }),
    // Logo placeholder only on the cover header (Slides can't insert empty text).
    ...(id === 'aa_hdr_1'
      ? [
          box(`${id}_logo`, page, 620, 8, 80, 48),
          ...text(`${id}_logo`, '{{LOGO}}', 8, { color: { red: 1, green: 1, blue: 1 } }),
        ]
      : []),
  ];
}

/** Creates the default 3-slide report template in the agency's Drive. Returns its file ID. */
export async function createReportTemplate(accessToken: string): Promise<string> {
  const pres = await googleRequest<{ presentationId: string; slides?: { objectId: string }[] }>(
    SLIDES,
    {
      accessToken,
      json: { title: 'Agency Autopilot - Report Template (do not delete)' },
    },
  );
  const firstSlide = pres.slides?.[0]?.objectId;
  const muted = { red: 0.39, green: 0.45, blue: 0.55 };

  const requests: object[] = [
    { createSlide: { objectId: 'aa_s1', slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    { createSlide: { objectId: 'aa_s2', slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    { createSlide: { objectId: 'aa_s3', slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    ...(firstSlide ? [{ deleteObject: { objectId: firstSlide } }] : []),

    // Slide 1: cover
    ...header('aa_hdr_1', 'aa_s1', '{{AGENCY_NAME}}'),
    box('aa_s1_title', 'aa_s1', 40, 110, 640, 60),
    ...text('aa_s1_title', '{{CLIENT_NAME}}', 34, { bold: true }),
    box('aa_s1_sub', 'aa_s1', 40, 170, 640, 30),
    ...text('aa_s1_sub', 'Monthly performance report · {{MONTH}}', 16, { color: muted }),
    box('aa_s1_score', 'aa_s1', 40, 230, 640, 60),
    ...text('aa_s1_score', 'Website health score: {{SCORE}}/100', 26, { bold: true }),
    box('aa_s1_link', 'aa_s1', 40, 350, 640, 24),
    ...text('aa_s1_link', 'Online version: {{REPORT_LINK}}', 10, { color: muted }),

    // Slide 2: KPIs + charts
    ...header('aa_hdr_2', 'aa_s2', 'Key numbers (last 28 days)'),
    box('aa_k1', 'aa_s2', 32, 80, 160, 70),
    ...text('aa_k1', 'Search clicks\n{{CLICKS}}\n{{CLICKS_CHANGE}}', 13),
    box('aa_k2', 'aa_s2', 200, 80, 160, 70),
    ...text('aa_k2', 'Website sessions\n{{SESSIONS}}\n{{SESSIONS_CHANGE}}', 13),
    box('aa_k3', 'aa_s2', 368, 80, 160, 70),
    ...text(
      'aa_k3',
      'Leads / key events\n{{KEY_EVENTS}}\nAvg. Google position {{AVG_POSITION}}',
      13,
    ),
    box('aa_k4', 'aa_s2', 536, 80, 160, 70),
    ...text('aa_k4', 'Site speed\nMobile {{MOBILE_SPEED}}/100\nDesktop {{DESKTOP_SPEED}}/100', 13),
    box('aa_c1_t', 'aa_s2', 32, 160, 320, 20),
    ...text('aa_c1_t', 'Daily search clicks', 11, { bold: true, color: muted }),
    box('aa_c1', 'aa_s2', 32, 182, 320, 190),
    ...text('aa_c1', '{{CHART_CLICKS}}', 8),
    box('aa_c2_t', 'aa_s2', 368, 160, 320, 20),
    ...text('aa_c2_t', 'Daily website sessions', 11, { bold: true, color: muted }),
    box('aa_c2', 'aa_s2', 368, 182, 320, 190),
    ...text('aa_c2', '{{CHART_SESSIONS}}', 8),

    // Slide 3: summary + action plan
    ...header('aa_hdr_3', 'aa_s3', 'Summary & next steps'),
    box('aa_sum', 'aa_s3', 32, 80, 656, 110),
    ...text('aa_sum', '{{SUMMARY}}', 12),
    box('aa_act_t', 'aa_s3', 32, 196, 656, 20),
    ...text('aa_act_t', 'What we will do next', 13, { bold: true }),
    box('aa_act', 'aa_s3', 32, 218, 656, 170),
    ...text('aa_act', '{{ACTIONS}}', 11),
  ];
  await googleRequest(`${SLIDES}/${pres.presentationId}:batchUpdate`, {
    accessToken,
    json: { requests },
  });
  return pres.presentationId;
}

/** True if the file exists, isn't trashed and our app can read it. */
export async function driveFileUsable(accessToken: string, fileId: string): Promise<boolean> {
  try {
    const f = await googleRequest<{ trashed?: boolean }>(
      `${DRIVE}/${encodeURIComponent(fileId)}?fields=id,trashed`,
      {
        accessToken,
        retries: 1,
      },
    );
    return !f.trashed;
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 403)) return false;
    throw err;
  }
}

export async function copyDriveFile(
  accessToken: string,
  fileId: string,
  name: string,
): Promise<string> {
  const f = await googleRequest<{ id: string }>(
    `${DRIVE}/${encodeURIComponent(fileId)}/copy?fields=id`,
    {
      accessToken,
      json: { name },
    },
  );
  return f.id;
}

export async function exportPdf(accessToken: string, fileId: string): Promise<Uint8Array> {
  return googleRequest<Uint8Array>(
    `${DRIVE}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('application/pdf')}`,
    { accessToken, responseType: 'bytes', timeoutMs: 120_000 },
  );
}

export async function slidesBatchUpdate(
  accessToken: string,
  presentationId: string,
  requests: object[],
) {
  if (requests.length === 0) return;
  await googleRequest(`${SLIDES}/${encodeURIComponent(presentationId)}:batchUpdate`, {
    accessToken,
    json: { requests },
  });
}

// ------------------------------------------- Gmail -------------------------------------------

const noNewlines = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, '$&\r\n');
const utf8B64 = (s: string) => bytesToBase64(new TextEncoder().encode(s));

/** Builds an RFC 2822 MIME message with an HTML body and one attachment. */
export function buildMimeMessage(msg: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  attachment?: { filename: string; contentType: string; bytes: Uint8Array };
}): string {
  const boundary = `aa_${randomToken(12)}`;
  const lines = [
    `To: ${noNewlines(msg.to)}`,
    ...(msg.replyTo ? [`Reply-To: ${noNewlines(msg.replyTo)}`] : []),
    `Subject: =?UTF-8?B?${utf8B64(noNewlines(msg.subject))}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8B64(msg.html)),
  ];
  if (msg.attachment) {
    const name = noNewlines(msg.attachment.filename).replace(/"/g, '');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${msg.attachment.contentType}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(bytesToBase64(msg.attachment.bytes)),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

/** Sends from the connected Gmail account (media upload endpoint supports up to 35 MB). */
export async function sendGmail(accessToken: string, mime: string): Promise<string> {
  const res = await googleRequest<{ id: string }>(
    'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media',
    // No retries: a retried send after a timeout could email the client twice.
    { accessToken, body: mime, contentType: 'message/rfc822', retries: 0 },
  );
  return res.id;
}
