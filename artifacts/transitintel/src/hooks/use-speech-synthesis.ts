/**
 * TTS (text-to-speech) hook tramite Web Speech API SpeechSynthesis.
 * 100% browser-side, gratis, niente backend.
 * Gestisce:
 *  - selezione automatica della voce italiana migliore disponibile
 *  - speak / stop / pause / resume
 *  - chunking di testi lunghi (alcuni browser tagliano > ~200 char)
 *  - sanitizzazione markdown prima di pronunciare
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseSpeechSynthesisOptions {
  lang?: string;       // default it-IT
  rate?: number;       // 0.1..10 (default 1)
  pitch?: number;      // 0..2 (default 1)
  volume?: number;     // 0..1 (default 1)
}

/** Rimuove markdown/code blocks per pronuncia naturale */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (blocco di codice) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Heuristic: è una voce "di qualità" (neural/premium/online) o una voce robotica di sistema?
 * Le voci robotiche sono quelle di default del 2005 (Luca, Alice base su macOS) — suonano sintetiche.
 * Le voci di qualità sono Neural/Premium/Enhanced/Siri/Online — suonano umane.
 */
export function isHighQualityVoice(v: SpeechSynthesisVoice): boolean {
  const n = v.name.toLowerCase();
  return /neural|premium|enhanced|wavenet|natural|online|cloud|siri|\(premium\)|\(enhanced\)/i.test(n);
}

function scoreVoice(v: SpeechSynthesisVoice): number {
  let s = 0;
  const n = v.name.toLowerCase();

  // ── QUALITÀ DEL MOTORE (priorità assoluta: una voce NATURALE vale più del genere) ──
  // Una Alice Premium è meglio di un Luca robotico. Una Luca Premium vince su tutto.
  if (/neural|wavenet|natural/i.test(n)) s += 600;
  if (/premium|enhanced/i.test(n)) s += 500;
  if (/\(premium\)|\(enhanced\)/i.test(v.name)) s += 300;
  if (/online|cloud/i.test(n)) s += 400;
  if (/siri/i.test(n)) s += 450;
  if (/google/i.test(n)) s += 200;
  if (/microsoft.*(online|natural)/i.test(n)) s += 350;

  // ── PREFERENZA SECONDARIA: voci MASCHILI italiane (Virgilio è maschio) ──
  const MALE_NAMES = /(luca|diego|cosimo|roberto|lorenzo|matteo|giorgio|stefano|marco|paolo|davide|enrico|google.*\bmale\b|it-it-standard-c|it-it-standard-d|it-it-wavenet-c|it-it-wavenet-d|it-it-neural2-c|it-it-neural2-d)/i;
  if (MALE_NAMES.test(n)) s += 150;

  // Piccola penalità alle voci femminili se esiste un'alternativa maschile di pari qualità
  const FEMALE_NAMES = /(alice|federica|paola|emma|chiara|elsa|isabella|sofia|giulia)/i;
  if (FEMALE_NAMES.test(n) && !MALE_NAMES.test(n)) s -= 30;

  if (v.localService) s += 2;
  return s;
}

export function listItalianVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return voices
    .filter((v) => v.lang?.toLowerCase().startsWith("it"))
    .sort((a, b) => scoreVoice(b) - scoreVoice(a));
}

function pickItalianVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const it = listItalianVoices(voices);
  return it[0] || null;
}

export function useSpeechSynthesis(opts: UseSpeechSynthesisOptions = {}) {
  const { lang = "it-IT", rate = 1, pitch = 1, volume = 1 } = opts;

  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voice, setVoiceState] = useState<SpeechSynthesisVoice | null>(null);
  const [italianVoices, setItalianVoices] = useState<SpeechSynthesisVoice[]>([]);
  const queueRef = useRef<SpeechSynthesisUtterance[]>([]);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setSupported(false);
      return;
    }
    setSupported(true);

    const refreshVoices = () => {
      const list = window.speechSynthesis.getVoices();
      const it = listItalianVoices(list);
      setItalianVoices(it);
      // Se l'utente ha salvato una voce in localStorage, usala
      const savedName = typeof window !== "undefined" ? localStorage.getItem("virgilio.voiceName") : null;
      const fromSaved = savedName ? it.find((v) => v.name === savedName) : null;
      const chosen = fromSaved || pickItalianVoice(list);
      if (chosen) setVoiceState(chosen);
    };
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
    return () => {
      try { window.speechSynthesis.cancel(); } catch {}
    };
  }, []);

  const setVoice = useCallback((v: SpeechSynthesisVoice | null) => {
    setVoiceState(v);
    if (v) {
      try { localStorage.setItem("virgilio.voiceName", v.name); } catch {}
    }
  }, []);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    queueRef.current = [];
    try { window.speechSynthesis.cancel(); } catch {}
    setSpeaking(false);
  }, []);

  /** Spezza un testo in frasi/chunk gestibili dal sintetizzatore */
  const chunk = (text: string, maxLen = 200): string[] => {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const out: string[] = [];
    let buf = "";
    for (const s of sentences) {
      if ((buf + " " + s).trim().length <= maxLen) {
        buf = (buf ? buf + " " : "") + s;
      } else {
        if (buf) out.push(buf);
        if (s.length > maxLen) {
          // forza split su virgole o spazi
          const sub = s.match(new RegExp(`.{1,${maxLen}}(\\s|$)`, "g")) || [s];
          out.push(...sub.map(x => x.trim()).filter(Boolean));
          buf = "";
        } else {
          buf = s;
        }
      }
    }
    if (buf) out.push(buf);
    return out;
  };

  const speak = useCallback((rawText: string) => {
    if (!supported) return;
    const text = sanitizeForSpeech(rawText);
    if (!text) return;

    // Stop eventuale precedente
    try { window.speechSynthesis.cancel(); } catch {}
    queueRef.current = [];
    stoppedRef.current = false;

    const parts = chunk(text);
    setSpeaking(true);

    parts.forEach((part, idx) => {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = lang;
      u.rate = rate;
      u.pitch = pitch;
      u.volume = volume;
      if (voice) u.voice = voice;
      if (idx === parts.length - 1) {
        u.onend = () => {
          if (!stoppedRef.current) setSpeaking(false);
        };
      }
      u.onerror = () => {
        if (!stoppedRef.current) setSpeaking(false);
      };
      queueRef.current.push(u);
      window.speechSynthesis.speak(u);
    });
  }, [supported, lang, rate, pitch, volume, voice]);

  return { supported, speaking, voice, italianVoices, setVoice, speak, stop };
}
