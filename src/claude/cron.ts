// The five-field cron Claude Code's CronCreate takes: wildcards, values, steps, ranges and lists, read in local time.
interface CronField {
  values: Set<number>;
  restricted: boolean;
}

export interface CronSchedule {
  minutes: CronField;
  hours: CronField;
  daysOfMonth: CronField;
  months: CronField;
  daysOfWeek: CronField;
}

const BOUNDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

// Four years of minutes reach every date a five-field expression can name, February 29th included.
const SEARCH_LIMIT_MINUTES = 4 * 366 * 24 * 60;

function parseField(text: string, [low, high]: [number, number]): CronField | null {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const [, start, end, step] = match;
    const from = start === "*" ? low : Number(start);
    const to = start === "*" ? high : end !== undefined ? Number(end) : step !== undefined ? high : from;
    const by = step !== undefined ? Number(step) : 1;
    if (from < low || to > high || from > to || by < 1) return null;
    for (let value = from; value <= to; value += by) values.add(value);
  }
  return { values, restricted: text !== "*" };
}

// Null when the expression is not one Claude Code would have accepted, so nothing is ever scheduled from a misreading.
export function parseCron(expression: string): CronSchedule | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed = fields.map((field, index) => parseField(field, BOUNDS[index]!));
  if (parsed.some((field) => field === null)) return null;
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as CronField[];
  // Cron takes 7 for Sunday as well as 0.
  if (daysOfWeek!.values.has(7)) daysOfWeek!.values.add(0);
  return { minutes: minutes!, hours: hours!, daysOfMonth: daysOfMonth!, months: months!, daysOfWeek: daysOfWeek! };
}

// When both day fields are restricted, either one matching is enough, as vixie cron reads them.
function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const byMonthDay = schedule.daysOfMonth.values.has(date.getDate());
  const byWeekDay = schedule.daysOfWeek.values.has(date.getDay());
  if (schedule.daysOfMonth.restricted && schedule.daysOfWeek.restricted) return byMonthDay || byWeekDay;
  return byMonthDay && byWeekDay;
}

// The first minute strictly after the given time that the schedule names, or null when it names none within a leap cycle.
export function nextFire(schedule: CronSchedule, after: Date): Date | null {
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let step = 0; step < SEARCH_LIMIT_MINUTES; step += 1) {
    if (!schedule.months.values.has(candidate.getMonth() + 1) || !dayMatches(schedule, candidate)) {
      candidate.setHours(0, 0, 0, 0);
      candidate.setDate(candidate.getDate() + 1);
      continue;
    }
    if (!schedule.hours.values.has(candidate.getHours())) {
      candidate.setMinutes(0, 0, 0);
      candidate.setHours(candidate.getHours() + 1);
      continue;
    }
    if (schedule.minutes.values.has(candidate.getMinutes())) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}
