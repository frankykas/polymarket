import { createHash } from "node:crypto";
import type { MacroForecastVintage } from "../types.js";

const SOURCE = "CLEVELAND_FED_INFLATION_NOWCAST" as const;
const DEFAULT_URL = "https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting";

interface ParsedNowcastRow {
  period: string;
  year: number;
  month: number;
  headline?: number;
  core?: number;
  updatedAt: number;
}

/** Parse the two current-month CPI tables published on the Cleveland Fed page. */
export function parseClevelandFedNowcastHtml(
  html: string,
  fetchedAt: number,
  sourceUrl = DEFAULT_URL
): MacroForecastVintage[] {
  const byPeriod = new Map<string, Partial<MacroForecastVintage>>();
  const tablePattern = /<table\b[^>]*>[\s\S]*?<caption\b[^>]*>([\s\S]*?)<\/caption>([\s\S]*?)<\/table>/gi;
  for (const match of html.matchAll(tablePattern)) {
    const caption = plainText(match[1]).toLowerCase();
    const metric = caption.includes("month-over-month")
      ? "MOM"
      : caption.includes("year-over-year")
        ? "YOY"
        : undefined;
    if (!metric) continue;
    for (const row of parseRows(match[2], fetchedAt)) {
      const existing = byPeriod.get(row.period) ?? {
        source: SOURCE,
        sourceUrl,
        referencePeriod: row.period,
        referenceYear: row.year,
        referenceMonth: row.month,
        fetchedAt,
        sourceUpdatedAt: row.updatedAt
      };
      existing.sourceUpdatedAt = Math.max(existing.sourceUpdatedAt ?? 0, row.updatedAt);
      if (metric === "MOM") {
        existing.headlineMom = row.headline;
        existing.coreMom = row.core;
      } else {
        existing.headlineYoy = row.headline;
        existing.coreYoy = row.core;
      }
      byPeriod.set(row.period, existing);
    }
  }
  return [...byPeriod.values()]
    .filter((row) => [row.headlineMom, row.coreMom, row.headlineYoy, row.coreYoy].some(Number.isFinite))
    .map((row) => {
      const complete = row as Omit<MacroForecastVintage, "id">;
      return { id: vintageId(complete), ...complete };
    })
    .sort((left, right) => right.referencePeriod.localeCompare(left.referencePeriod));
}

export async function fetchClevelandFedNowcast(
  sourceUrl = DEFAULT_URL,
  fetchedAt = Date.now()
): Promise<MacroForecastVintage[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(sourceUrl, {
      headers: { accept: "text/html", "user-agent": "StratiFi-macro-research/1.0" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for Cleveland Fed nowcast`);
    const vintages = parseClevelandFedNowcastHtml(await response.text(), fetchedAt, sourceUrl);
    if (vintages.length === 0) throw new Error("Cleveland Fed nowcast tables contained no current CPI values");
    return vintages;
  } finally {
    clearTimeout(timer);
  }
}

function parseRows(table: string, fetchedAt: number): ParsedNowcastRow[] {
  const rows: ParsedNowcastRow[] = [];
  for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => plainText(cell[1]));
    if (cells.length < 6) continue;
    const periodDate = Date.parse(`${cells[0]} 1 UTC`);
    if (!Number.isFinite(periodDate)) continue;
    const date = new Date(periodDate);
    const headline = optionalNumber(cells[1]);
    const core = optionalNumber(cells[2]);
    if (headline === undefined && core === undefined) continue;
    rows.push({
      period: `${date.getUTCFullYear()}-M${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      headline,
      core,
      updatedAt: sourceDate(cells[5], fetchedAt)
    });
  }
  return rows;
}

function sourceDate(value: string, fetchedAt: number): number {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!match) return fetchedAt;
  let year = match[3]
    ? Number(match[3]) + (Number(match[3]) < 100 ? 2_000 : 0)
    : new Date(fetchedAt).getUTCFullYear();
  let timestamp = Date.UTC(year, Number(match[1]) - 1, Number(match[2]), 12);
  if (!match[3] && timestamp > fetchedAt + 24 * 60 * 60_000) {
    year -= 1;
    timestamp = Date.UTC(year, Number(match[1]) - 1, Number(match[2]), 12);
  }
  return timestamp;
}

function vintageId(vintage: Omit<MacroForecastVintage, "id">): string {
  const identity = [
    vintage.source,
    vintage.referencePeriod,
    vintage.sourceUpdatedAt,
    vintage.headlineMom,
    vintage.coreMom,
    vintage.headlineYoy,
    vintage.coreYoy
  ].join("|");
  return `macro_vintage_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function optionalNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
