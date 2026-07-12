import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DictationLanguage, DictationTransform } from "./types.js";
import { VOICE_LANGUAGES } from "./languages.js";
import { getSpeechRecognitionCtor, isDictationSupported, resolveInitialLang } from "./support.js";

const DEFAULT_STORAGE_KEY = "vonzio_voice_lang";

export interface UseVoiceDictationOptions {
  /** Current value of the target field, read once when dictation starts — the
   *  transcript is appended to it. */
  getBaseText: () => string;
  /** Called on every partial/final result with the full composed value (base +
   *  transcript). Write it into your input. Never sends — the user reviews. */
  onText: (next: string) => void;
  /** Language list for the picker + browser-language mapping. Default: the
   *  built-in curated `VOICE_LANGUAGES`. */
  languages?: DictationLanguage[];
  /** localStorage key for remembering the last-used language. Default:
   *  "vonzio_voice_lang". Pass a per-app key to keep projects independent. */
  storageKey?: string;
  /** Force the initial language, bypassing persisted/browser resolution. */
  initialLang?: string;
  /** Optional cleanup applied to the dictated segment before composing (e.g.
   *  capitalization, spoken-punctuation). See {@link DictationTransform}. */
  transform?: DictationTransform;
}

export interface VoiceDictation {
  /** Whether dictation can run here (support + secure context). */
  supported: boolean;
  /** Whether a recognition session is currently active. */
  listening: boolean;
  /** Current dictation language (BCP-47). */
  lang: string;
  /** Change + persist the dictation language. */
  setLang: (next: string) => void;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

/** Web Speech API dictation bound to a text field. On every partial/final
 *  result the hook rebuilds the full value (the text present when dictation
 *  started + the running transcript) and hands it to `onText`, which writes it
 *  into the field. Text is never auto-sent — the caller reviews and submits. */
export function useVoiceDictation(opts: UseVoiceDictationOptions): VoiceDictation {
  const languages = opts.languages ?? VOICE_LANGUAGES;
  const storageKey = opts.storageKey ?? DEFAULT_STORAGE_KEY;

  const supported = useMemo(() => isDictationSupported(), []);
  const [listening, setListening] = useState(false);
  const [lang, setLangState] = useState<string>(
    () => opts.initialLang ?? resolveInitialLang(languages, storageKey),
  );

  const recognitionRef = useRef<any>(null);
  // Text captured when dictation started — the transcript is appended to it.
  // Held in refs so the non-React recognition callbacks read the latest.
  const baseRef = useRef("");
  const finalRef = useRef("");
  const langRef = useRef(lang);
  langRef.current = lang;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const setLang = useCallback((next: string) => {
    setLangState(next);
    try { localStorage.setItem(storageKey, next); } catch { /* ignore */ }
    if (recognitionRef.current) recognitionRef.current.lang = next;
  }, [storageKey]);

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) { try { rec.stop(); } catch { /* already stopped */ } }
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor || recognitionRef.current) return;
    const rec = new Ctor();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;
    baseRef.current = optsRef.current.getBaseText();
    finalRef.current = "";
    rec.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalRef.current += res[0].transcript;
        else interim += res[0].transcript;
      }
      let dictated = (finalRef.current + interim).trimStart();
      const transform = optsRef.current.transform;
      if (transform) dictated = transform(dictated, { isFinal: interim === "", lang: langRef.current });
      const base = baseRef.current;
      const sep = base && !/\s$/.test(base) ? " " : "";
      optsRef.current.onText(dictated ? base + sep + dictated : base);
    };
    rec.onerror = () => { /* no-op: onend still fires and clears state */ };
    rec.onend = () => { recognitionRef.current = null; setListening(false); };
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      setListening(false);
    }
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => () => {
    const rec = recognitionRef.current;
    if (rec) { try { rec.stop(); } catch { /* ignore */ } }
  }, []);

  return { supported, listening, lang, setLang, start, stop, toggle };
}
