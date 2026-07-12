// @vonzio/dictation — headless browser voice dictation (Web Speech API).
//
// A React hook that streams speech into a text field for review before sending,
// with language persistence and an optional transform seam for formatting /
// proofreading. Headless by design: it owns the recognition engine + language
// state; the mic button and language picker are the consumer's UI.

export { useVoiceDictation } from "./useVoiceDictation.js";
export type { UseVoiceDictationOptions, VoiceDictation } from "./useVoiceDictation.js";
export { VOICE_LANGUAGES } from "./languages.js";
export { getSpeechRecognitionCtor, isDictationSupported, resolveInitialLang } from "./support.js";
export type { DictationLanguage, DictationTransform } from "./types.js";
