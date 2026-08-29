/**
 * Input orario HH:MM riusabile (estratto dal pattern del Grafico TTD):
 * testo libero così ammette ore >24 per il dopo-mezzanotte, commit su blur
 * (Enter → blur), bottoni −/+ da 1 minuto. `key` derivata dal valore: quando
 * il chiamante aggiorna `value` l'input si rimonta pulito.
 */
const HHMM_RE = /^\d{1,2}:\d{2}$/;

function hmToMin(v: string): number | null {
  if (!HHMM_RE.test(v)) return null;
  const [h, m] = v.split(":").map(Number);
  return m > 59 ? null : h * 60 + m;
}
const minToHm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export default function TimeInput({ value, onCommit, disabled, title, className }: {
  /** HH:MM corrente (anche >24) */
  value: string;
  /** chiamato SOLO con un HH:MM valido e diverso dal corrente */
  onCommit: (hhmm: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const commit = (raw: string) => {
    const v = raw.trim();
    if (v === value) return;
    if (hmToMin(v) == null) return; // input non valido: il rimontaggio ripristina il valore
    onCommit(v);
  };
  const nudge = (delta: number) => {
    const m = hmToMin(value);
    if (m == null) return;
    const next = m + delta;
    if (next < 0) return;
    onCommit(minToHm(next));
  };
  return (
    <span className={`inline-flex items-center gap-0.5 ${className ?? ""}`}>
      <button onClick={() => nudge(-1)} disabled={disabled} tabIndex={-1}
        className="px-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-30" title="−1 minuto">−</button>
      <input
        key={value}
        defaultValue={value}
        disabled={disabled}
        title={title}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 font-mono text-center text-[11px] disabled:opacity-40"
      />
      <button onClick={() => nudge(1)} disabled={disabled} tabIndex={-1}
        className="px-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-30" title="+1 minuto">+</button>
    </span>
  );
}
