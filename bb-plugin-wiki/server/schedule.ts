import type { IngestResult } from "../contract.js";
import { isoDateSchema } from "../contract.js";
import { isValidTimeZone, todayInZone } from "../lib/daily-notes.js";
import type { WikiContext, WikiSettings } from "./context.js";
import { runIngest } from "./ingest.js";

export const SCHEDULE_SERVICE = "daily-ingest";
export const LAST_INGEST_KEY = "lastIngestDate";
export const SCHEDULE_INTERVAL_MS = 60_000;

export interface ScheduleOptions {
  intervalMs?: number;
  now?: () => Date;
}

type ScheduleSettings = Pick<WikiSettings, "ingestTime" | "timezone">;

const TIME_LOCALE = "en-US-u-nu-latn";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  const zone = timeZone.trim();
  return new Intl.DateTimeFormat(TIME_LOCALE, zone !== "" && isValidTimeZone(zone) ? { ...options, timeZone: zone } : options);
}

export function localTimeOfDay(now: Date, timeZone: string): string {
  const parts = timeFormatter(timeZone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => (parts.find((entry) => entry.type === type)?.value ?? "00").padStart(2, "0");
  return `${part("hour")}:${part("minute")}`;
}

export function nextIngestDue(now: Date, settings: ScheduleSettings, lastIngestDate: string | null): boolean {
  const today = todayInZone(settings.timezone, now);
  if (lastIngestDate !== null && lastIngestDate >= today) return false;
  return localTimeOfDay(now, settings.timezone) >= settings.ingestTime;
}

export async function readLastIngestDate(ctx: WikiContext): Promise<string | null> {
  const parsed = isoDateSchema.safeParse(await ctx.bb.storage.kv.get<unknown>(LAST_INGEST_KEY));
  return parsed.success ? parsed.data : null;
}

export async function runDueIngest(ctx: WikiContext, now: Date): Promise<IngestResult | null> {
  const settings = await ctx.settings();
  if (!settings.ingestEnabled) return null;
  if (!nextIngestDue(now, settings, await readLastIngestDate(ctx))) return null;
  const today = todayInZone(settings.timezone, now);
  const result = await runIngest(ctx, { since: null, useAgent: null });
  await ctx.bb.storage.kv.set(LAST_INGEST_KEY, today);
  ctx.log.info(`Wiki daily ingest: ${result.cardsCreated} new inbox cards from ${result.notesScanned} notes.`);
  return result;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function registerSchedule(ctx: WikiContext, options: ScheduleOptions = {}): void {
  const intervalMs = options.intervalMs ?? SCHEDULE_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  ctx.bb.background.service(SCHEDULE_SERVICE, {
    async start(signal) {
      let lastProblem = "";
      while (!signal.aborted) {
        try {
          await runDueIngest(ctx, now());
          lastProblem = "";
        } catch (error) {
          const problem = errorMessage(error);
          if (problem !== lastProblem) ctx.log.warn(`Wiki daily ingest failed: ${problem}`);
          lastProblem = problem;
        }
        await sleep(intervalMs, signal);
      }
    },
  });
}
