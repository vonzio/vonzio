// CalDAV calendar connector (feature 0037) — same no-OAuth pattern as the
// mail connector (0035). One connector for Google Calendar (app password),
// iCloud, Fastmail, Nextcloud, any CalDAV server. Credentials are a
// user-pasted app password, encrypted at rest.
//
// Connections originate from the SERVER (agents talk to /mcp/calendar with
// a per-session bearer token, never the password). The user-controlled
// caldav_url is SSRF-guarded: a wrapping fetch resolves + IP-blocklists the
// host on every request (tsdav uses global fetch, so we inject our own),
// and HTTPS is required.

// tsdav + ical.js are CJS/dual-build deps. A named VALUE import
// (`import { DAVClient }`) throws at RUNTIME under Node's ESM loader
// ("does not provide an export named 'DAVClient'") even though tsc and
// vitest accept it — they resolve CJS interop differently than tsx/node
// in production. So: import the TYPES with `import type` (erased, always
// safe) and resolve the runtime VALUES off a namespace import with a
// default-export fallback that works whichever build condition wins.
import type { DAVClient as DAVClientCtor, DAVCalendar } from "tsdav";
import * as tsdavNs from "tsdav";
import * as icalNs from "ical.js";
import { assertSocketHostAllowed } from "../lib/safe-webhook-fetch.js";

const DAVClient = (tsdavNs.DAVClient
  ?? (tsdavNs as unknown as { default: { DAVClient: typeof tsdavNs.DAVClient } }).default.DAVClient);
const ICAL = ((icalNs as { default?: unknown }).default ?? icalNs) as typeof import("ical.js").default;
type DAVClient = DAVClientCtor;

export interface CalendarConfig {
  caldav_url: string;
  username: string;
  password: string;
}

export interface CalendarSummary {
  url: string;
  displayName: string;
}

export interface EventSummary {
  uid: string;
  calendarUrl: string;
  objectUrl: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
}

// SSRF-guarding fetch: reject non-HTTPS and any URL whose host resolves to
// a blocked (internal/metadata/loopback) range, on EVERY request tsdav
// makes. This is re-checked per call — a stored public URL that later
// rebinds to a private IP is caught at request time (small TOCTOU window
// remains vs full IP-pinning; documented, phase-2 hardening).
async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const url = new URL(urlStr);
  if (url.protocol !== "https:") {
    throw new Error(`CalDAV requires https (got ${url.protocol})`);
  }
  await assertSocketHostAllowed(url.hostname);
  return fetch(input as RequestInfo, init);
}

function daysFromNow(days: number): string {
  // ISO without millis, UTC — CalDAV time-range wants YYYYMMDDTHHMMSSZ, but
  // tsdav accepts ISO and normalizes. Keep it simple + explicit.
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export class CalendarService {
  private async client(cfg: CalendarConfig): Promise<DAVClient> {
    // Guard the base URL up front too (before login), so an internal host
    // fails fast rather than only on the first collection request.
    const base = new URL(cfg.caldav_url);
    if (base.protocol !== "https:") throw new Error("CalDAV requires an https URL");
    await assertSocketHostAllowed(base.hostname);
    const client = new DAVClient({
      serverUrl: cfg.caldav_url,
      credentials: { username: cfg.username, password: cfg.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
      fetch: guardedFetch as typeof fetch,
    });
    await client.login();
    return client;
  }

  /** Live credential check: login + list calendars. Throws a readable
   *  reason on failure (surfaced in the connect modal). */
  async verify(cfg: CalendarConfig): Promise<void> {
    try {
      const client = await this.client(cfg);
      await client.fetchCalendars();
    } catch (err) {
      throw new Error(`CalDAV connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async listCalendars(cfg: CalendarConfig): Promise<CalendarSummary[]> {
    const client = await this.client(cfg);
    const cals = await client.fetchCalendars();
    return cals.map((c: DAVCalendar) => ({
      url: c.url,
      displayName: typeof c.displayName === "string" ? c.displayName : "(unnamed)",
    }));
  }

  /** Events across all calendars within [now, now+days]. Capped. */
  async listEvents(cfg: CalendarConfig, opts: { days?: number; limit?: number; calendarUrl?: string }): Promise<EventSummary[]> {
    const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const client = await this.client(cfg);
    const cals = await client.fetchCalendars();
    const targets = opts.calendarUrl ? cals.filter((c: DAVCalendar) => c.url === opts.calendarUrl) : cals;
    const timeRange = { start: new Date().toISOString(), end: daysFromNow(days) };
    const out: EventSummary[] = [];
    for (const cal of targets) {
      const objects = await client.fetchCalendarObjects({ calendar: cal, timeRange, expand: true });
      for (const obj of objects) {
        if (!obj.data) continue;
        try {
          const parsed = new ICAL.Component(ICAL.parse(obj.data));
          for (const vevent of parsed.getAllSubcomponents("vevent")) {
            const ev = new ICAL.Event(vevent);
            out.push({
              uid: ev.uid,
              calendarUrl: cal.url,
              objectUrl: obj.url,
              summary: ev.summary || "(no title)",
              start: ev.startDate ? ev.startDate.toJSDate().toISOString() : "",
              end: ev.endDate ? ev.endDate.toJSDate().toISOString() : "",
              ...(ev.location ? { location: ev.location } : {}),
            });
          }
        } catch {
          // Skip an unparseable object rather than fail the whole listing.
        }
      }
    }
    out.sort((a, b) => (a.start < b.start ? -1 : 1));
    return out.slice(0, limit);
  }

  /** Create a single timed event on the first (or named) calendar. */
  async createEvent(cfg: CalendarConfig, opts: {
    summary: string;
    start: string;
    end: string;
    location?: string;
    description?: string;
    calendarUrl?: string;
  }): Promise<{ uid: string; calendarUrl: string }> {
    const client = await this.client(cfg);
    const cals = await client.fetchCalendars();
    const cal = (opts.calendarUrl ? cals.find((c: DAVCalendar) => c.url === opts.calendarUrl) : cals[0]);
    if (!cal) throw new Error("No writable calendar found");

    const uid = `vonzio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@vonzio`;
    const comp = new ICAL.Component(["vcalendar", [], []]);
    comp.updatePropertyWithValue("prodid", "-//vonzio//caldav//EN");
    comp.updatePropertyWithValue("version", "2.0");
    const vevent = new ICAL.Component("vevent");
    const event = new ICAL.Event(vevent);
    event.uid = uid;
    event.summary = opts.summary;
    event.startDate = ICAL.Time.fromJSDate(new Date(opts.start), false);
    event.endDate = ICAL.Time.fromJSDate(new Date(opts.end), false);
    if (opts.location) event.location = opts.location;
    if (opts.description) event.description = opts.description;
    comp.addSubcomponent(vevent);

    const res = await client.createCalendarObject({
      calendar: cal,
      filename: `${uid}.ics`,
      iCalString: comp.toString(),
    });
    if (!res.ok) throw new Error(`Create failed: ${res.status} ${res.statusText}`);
    return { uid, calendarUrl: cal.url };
  }

  /** Delete an event by its object URL (from listEvents). */
  async deleteEvent(cfg: CalendarConfig, objectUrl: string): Promise<void> {
    // The object URL is server-supplied (from a prior fetch) but flows
    // through the guarded client, so the host is re-checked.
    const client = await this.client(cfg);
    const res = await client.deleteCalendarObject({ calendarObject: { url: objectUrl, etag: "" } });
    if (!res.ok) throw new Error(`Delete failed: ${res.status} ${res.statusText}`);
  }
}
