/**
 * Friendly display names for known model IDs.
 *
 * Used by both the composer's `ModelPicker` and the `WorkspaceHeader` model
 * readout when the server's `/v1/profiles/:id/models` endpoint hasn't loaded
 * yet (or returned an empty list). Keeping a single source means a new model
 * shipped by Anthropic only needs to be added here once.
 */
export const MODEL_DISPLAY_FALLBACK: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-fable-5": "Claude Fable 5",
  "claude-fable-5-1": "Claude Fable 5.1",
};
