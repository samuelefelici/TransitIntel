/**
 * Chips di selezione delle CATEGORIE di validità (calendario aziendale):
 * Scuole Aperte/Chiuse (con i periodi specifici sotto l'ombrello), Festività…
 * Condiviso tra la sezione Corse e la zona Percorrenze.
 */
import type { PsValidityCategory } from "@/lib/planning-studio-validity-units-api";

export default function CategoryChips({ categories, selected, onChange, disabled, emptyHint }: {
  categories: PsValidityCategory[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  emptyHint?: string;
}) {
  const isSub = (c: PsValidityCategory) => !!c.code && c.code.startsWith("scuole_chiuse_");
  const subs = [...categories].filter(isSub).sort((a, b) => a.name.localeCompare(b.name, "it", { numeric: true }));
  const rank = (c: PsValidityCategory) =>
    c.code === "scuole_aperte" ? 0 : c.code === "scuole_chiuse" ? 1 : c.code === "festivita" ? 3 : 2;
  const tops = [...categories].filter(c => !isSub(c)).sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder);
  const set = (ids: string[], next: boolean) => {
    const n = new Set(selected);
    for (const id of ids) { if (next) n.add(id); else n.delete(id); }
    onChange(n);
  };
  const chip = (c: PsValidityCategory, sel: boolean) => (
    <label key={c.id} className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border select-none ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
      style={{ borderColor: sel ? (c.color || "#3b82f6") : "#334155", background: sel ? `${c.color || "#3b82f6"}22` : "transparent", color: sel ? undefined : "#94a3b8" }}>
      <input type="checkbox" className="hidden" checked={sel} disabled={disabled} onChange={() => set([c.id], !sel)} />
      {c.name}
    </label>
  );
  if (categories.length === 0) return <span className="text-[11px] text-slate-500">{emptyHint ?? "Nessuna categoria definita."}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tops.map(c => {
        if (c.code === "scuole_chiuse" && subs.length > 0) {
          // OMBRELLO: la categoria generica "Scuole Chiuse" è assegnabile e vale
          // in TUTTI i periodi (anche quelli aggiunti in futuro). Sotto restano i
          // singoli periodi per un eventuale vincolo specifico.
          const genSel = selected.has(c.id);
          return (
            <div key={c.id} className="basis-full">
              <label className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border select-none font-medium ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                style={{ borderColor: genSel ? (c.color || "#f59e0b") : "#334155", background: genSel ? `${c.color || "#f59e0b"}22` : "transparent", color: genSel ? undefined : "#94a3b8" }}
                title="Vale in TUTTI i periodi di scuole chiuse (estivo, invernale, Natale, Pasqua…), inclusi quelli aggiunti in futuro">
                <input type="checkbox" className="hidden" checked={genSel} disabled={disabled} onChange={() => set([c.id], !genSel)} />
                {c.name} <span className="opacity-60 font-normal">· tutti i periodi</span>
              </label>
              <div className="mt-1 ml-3 pl-2 border-l border-slate-700 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-slate-500">oppure un periodo specifico:</span>
                {subs.map(s => chip(s, selected.has(s.id)))}
              </div>
            </div>
          );
        }
        return chip(c, selected.has(c.id));
      })}
    </div>
  );
}
