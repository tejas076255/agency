// Google Sheets API (Phase 2): formatted client spreadsheets in the agency's Drive.
// Uses the agency workspace connection with the drive.file scope (app-created files only).
import { googleRequest } from './http';

export type SheetTab = { title: string; rows: (string | number | null)[][] };

/** Sheet titles: max 100 chars, no []:*?/\ characters. */
export function safeSheetTitle(t: string): string {
  return t.replace(/[[\]:*?/\\]/g, ' ').slice(0, 90) || 'Sheet';
}

export async function createSpreadsheet(token: string, title: string, tabs: SheetTab[]) {
  const created = await googleRequest<{
    spreadsheetId: string;
    spreadsheetUrl: string;
    sheets: { properties: { sheetId: number; title: string } }[];
  }>('https://sheets.googleapis.com/v4/spreadsheets', {
    accessToken: token,
    json: {
      properties: { title, locale: 'en_IN', timeZone: 'Asia/Kolkata' },
      sheets: tabs.map((t) => ({ properties: { title: safeSheetTitle(t.title) } })),
    },
  });

  await googleRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${created.spreadsheetId}/values:batchUpdate`,
    {
      accessToken: token,
      json: {
        valueInputOption: 'RAW',
        data: tabs.map((t) => ({
          range: `'${safeSheetTitle(t.title)}'!A1`,
          values: t.rows.map((r) => r.map((v) => v ?? '')),
        })),
      },
    },
  );

  // Formatting: bold, frozen header row and auto-sized columns on every tab.
  const requests = created.sheets.flatMap((s) => [
    {
      updateSheetProperties: {
        properties: { sheetId: s.properties.sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId: s.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.93, green: 0.95, blue: 0.98 },
          },
        },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    },
    {
      autoResizeDimensions: {
        dimensions: {
          sheetId: s.properties.sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: 10,
        },
      },
    },
  ]);
  await googleRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${created.spreadsheetId}:batchUpdate`,
    {
      accessToken: token,
      json: { requests },
    },
  );

  return { spreadsheetId: created.spreadsheetId, url: created.spreadsheetUrl };
}
