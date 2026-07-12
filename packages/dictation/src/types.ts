export interface DictationLanguage {
  /** BCP-47 tag passed to SpeechRecognition (e.g. "en-US", "fr-FR"). */
  code: string;
  /** Human-readable label for a language picker. */
  label: string;
}

/** Transform applied to the *dictated segment* (not the pre-existing base text)
 *  before it's composed back into the field. Runs on every result; `isFinal`
 *  marks a finalized utterance vs. a live interim. Kept synchronous so interim
 *  updates stay low-latency and results can't land out of order — an async
 *  cleanup layer (e.g. on-device proofreading) belongs on top of `onText` for
 *  final utterances, not here. */
export type DictationTransform = (
  text: string,
  ctx: { isFinal: boolean; lang: string },
) => string;
