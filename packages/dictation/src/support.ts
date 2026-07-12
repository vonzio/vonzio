import type { DictationLanguage } from "./types.js";

/** The SpeechRecognition constructor (webkit-prefixed on some browsers), or
 *  null where it doesn't exist (Firefox, non-browser). */
export function getSpeechRecognitionCtor(): (new () => any) | null {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null;
}

/** Whether dictation can actually run here: SpeechRecognition present AND a
 *  secure context (mic access requires https/localhost). UIs should hide the
 *  control when this is false rather than render a button that can't work. */
export function isDictationSupported(): boolean {
  return !!getSpeechRecognitionCtor() && (typeof window === "undefined" || window.isSecureContext);
}

/** Initial dictation language: last-used (persisted under `storageKey`) →
 *  browser top language mapped onto `languages` (exact, else by primary
 *  subtag) → the first language in the list. */
export function resolveInitialLang(languages: DictationLanguage[], storageKey: string): string {
  const fallback = languages[0]?.code ?? "en-US";
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && languages.some((l) => l.code === saved)) return saved;
  } catch { /* localStorage unavailable */ }
  const nav = (typeof navigator !== "undefined" && navigator.language) || fallback;
  const exact = languages.find((l) => l.code.toLowerCase() === nav.toLowerCase());
  if (exact) return exact.code;
  const primary = nav.split("-")[0].toLowerCase();
  return languages.find((l) => l.code.split("-")[0].toLowerCase() === primary)?.code ?? fallback;
}
