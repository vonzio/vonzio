import type { DictationLanguage } from "./types.js";

/** Curated common-languages list (BCP-47). Not exhaustive — the Web Speech API
 *  accepts any tag, but a short list keeps a picker usable; the browser's top
 *  language seeds the default when it maps onto one of these. Consumers can pass
 *  their own list to `useVoiceDictation({ languages })`. */
export const VOICE_LANGUAGES: DictationLanguage[] = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Español" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "it-IT", label: "Italiano" },
  { code: "pt-BR", label: "Português (BR)" },
  { code: "pt-PT", label: "Português (PT)" },
  { code: "nl-NL", label: "Nederlands" },
  { code: "pl-PL", label: "Polski" },
  { code: "ru-RU", label: "Русский" },
  { code: "tr-TR", label: "Türkçe" },
  { code: "ar-SA", label: "العربية" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "zh-CN", label: "中文 (简体)" },
  { code: "zh-TW", label: "中文 (繁體)" },
  { code: "ja-JP", label: "日本語" },
  { code: "ko-KR", label: "한국어" },
];
