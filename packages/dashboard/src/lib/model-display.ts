/**
 * Friendly display names for known model IDs.
 *
 * Used by both the composer's `ModelPicker` and the `WorkspaceHeader` model
 * readout when the server's `/v1/profiles/:id/models` endpoint hasn't loaded
 * yet (or returned an empty list). Keeping a single source means a new model
 * shipped by Anthropic only needs to be added here once.
 */
export const MODEL_DISPLAY_FALLBACK: Record<string, string> = {
  "claude-opus-4-7": "Opus 4.7",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
};
