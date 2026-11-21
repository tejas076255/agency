import { eq } from 'drizzle-orm';
import { reportSettings } from '../db/schema';
import type { Env } from '../env';
import { getDb } from './db';

export type ReportSettings = {
  /** Placeholders: {client}, {month}, {agency} */
  emailSubject: string;
  emailMessage: string;
  ccAgency: boolean;
  includeHinglish: boolean;
};

export const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  emailSubject: '{client}: {month} website report from {agency}',
  emailMessage:
    'Hi, here is your monthly website report. The PDF is attached and you can also view it online.',
  ccAgency: false,
  includeHinglish: false,
};

/** Report email settings for an agency, with defaults filled in. */
export async function loadReportSettings(
  env: Pick<Env, 'DB'>,
  agencyId: string,
): Promise<ReportSettings> {
  const row = await getDb(env).query.reportSettings.findFirst({
    where: eq(reportSettings.agencyId, agencyId),
  });
  return {
    emailSubject: row?.emailSubject || DEFAULT_REPORT_SETTINGS.emailSubject,
    emailMessage: row?.emailMessage || DEFAULT_REPORT_SETTINGS.emailMessage,
    ccAgency: row?.ccAgency ?? false,
    includeHinglish: row?.includeHinglish ?? false,
  };
}
