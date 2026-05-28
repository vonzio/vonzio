import type { Tracker, TrackerOptions, TrackInput, EventRecord } from "./types.js";

const noopLog = { error: () => {} };

export function createTracker(opts: TrackerOptions): Tracker {
  const { write, log = noopLog } = opts;

  async function writeOne(input: TrackInput): Promise<boolean> {
    const record: EventRecord & { created_at: string } = {
      event: input.event,
      source: input.source ?? "server",
      user_id: input.userId ?? null,
      org_id: input.orgId ?? null,
      session_id: input.sessionId ?? null,
      properties: input.properties ?? null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
      created_at: new Date().toISOString(),
    };
    try {
      await write(record);
      return true;
    } catch (err) {
      log.error({ err, event: record.event }, "event-tracker: write failed");
      return false;
    }
  }

  return {
    track(input) {
      void writeOne(input);
    },
    trackSync(input) {
      return writeOne(input);
    },
  };
}
