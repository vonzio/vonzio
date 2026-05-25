/**
 * Single source of truth for notification delivery channels.
 *
 * Before this constant existed the 4 channel names were duplicated as
 * literals across at least six call sites (notify-mcp tool schema,
 * notify-mcp dispatcher cast, integrations route cast, notification-service
 * `send()` signature, notification-service log dispatcher, and a stale
 * schema comment) — when telegram support was added to the service, the
 * notify-mcp tool's enum and its cast were never updated, so agents could
 * never actually push notifications to telegram.
 *
 * Spread this array (`[...NOTIFICATION_CHANNELS]`) into anywhere that
 * needs the values; use `NotificationChannel` for the type. Adding a new
 * channel means editing only this file.
 */
export const NOTIFICATION_CHANNELS = ["slack", "email", "webhook", "telegram"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
