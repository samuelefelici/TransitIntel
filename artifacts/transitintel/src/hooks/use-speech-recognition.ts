/**
 * Web Speech API hook (riconoscimento vocale lato browser).
 * Supportato su Chrome/Edge/Safari (Firefox no).
 * Nessun costo, niente backend: lo speech-to-text avviene nel browser.
 */
import { useEffect, useRef, useState, useCallback } from "react";

// Types per Web Speech API (non sempre presenti nei lib.dom.d.ts)
interface ISpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => ISpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export interface UseSpeechRecognitionOptions {
  lang?: string;          // default it-IT
  continuous?: boolean;   // default false (parla → silenzio → stop)
  interimResults?: boolean; // default true
  onFinalResult?: (transcript: string) => void;
}

export function useSpeechRecognition(opts: UseSpeechRecognitionOptions = {}) {
  const {
    lang = "it-IT",
    continuous = false,
    interimResults = true,
    onFinalResult,
  } = opts;

  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<ISpeechRecognition | null>(null);
  const onFinalRef = useRef(onFinalResult);

  // Mantieni callback aggiornata senza ri-creare il recognizer
  useEffect(() => { onFinalRef.current = onFinalResult; }, [onFinalResult]);

  useEffect(() => {
    const Ctor =
      (typeof window !== "undefined" &&
        (window.SpeechRecognition || window.webkitSpeechRecognition)) || null;
    if (!Ctor) {
      setSupported(false);
      return;
    }
    setSupported(true);
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = continuous;
    rec.interimResults = interimResults;
    rec.maxAlternatives = 1;

    rec.onresult = (ev: any) => {
      let finalTxt = "";
      let interimTxt = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const alt = res[0]?.transcript || "";
        if (res.isFinal) finalTxt += alt;
        else interimTxt += alt;
      }
      if (interimTxt) setInterimTranscript(interimTxt);
      if (finalTxt) {
        setTranscript(prev => (prev ? prev + " " : "") + finalTxt.trim());
        setInterimTranscript("");
        onFinalRef.current?.(finalTxt.trim());
      }
    };
    rec.onerror = (ev: any) => {
      const code = ev?.error || "unknown";
      const msg =
        code === "not-allowed" ? "Permesso microfono negato" :
        code === "no-speech"    ? "Nessuna voce rilevata" :
        code === "audio-capture" ? "Microfono non disponibile" :
        `Errore: ${code}`;
      setError(msg);
      setListening(false);
    };
    rec.onend = () => setListening(false);
    rec.onstart = () => { setError(null); setListening(true); };

    recRef.current = rec;
    return () => {
      try { rec.abort(); } catch {}
      recRef.current = null;
    };
  }, [lang, continuous, interimResults]);

  const start = useCallback(() => {
    setError(null);
    setTranscript("");
    setInterimTranscript("");
    try { recRef.current?.start(); }
    catch (e: any) { setError(e?.message || "Impossibile avviare"); }
  }, []);

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch {}
  }, []);

  const reset = useCallback(() => {
    setTranscript("");
    setInterimTranscript("");
    setError(null);
  }, []);

  return { supported, listening, transcript, interimTranscript, error, start, stop, reset };
}
