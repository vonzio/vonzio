export { createTracker } from "./tracker.js";
export { eventTrackerPlugin } from "./fastify-plugin.js";
export type {
  Tracker,
  TrackerOptions,
  TrackerLogger,
  TrackInput,
  EventRecord,
  EnrichContext,
  EnrichFn,
  WriteFn,
} from "./types.js";
export type { EventTrackerPluginOptions, RouteEvent } from "./fastify-plugin.js";
