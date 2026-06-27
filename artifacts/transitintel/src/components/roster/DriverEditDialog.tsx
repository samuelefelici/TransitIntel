/**
 * Anagrafica conducente — crea/modifica un operatore del Roster con i dati
 * completi (matricola, anagrafica, lavoro, documenti/scadenze).
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, X, Save } from "lucide-react";
import { apiFetch } from "@/lib/api";

export interface RosterDriver {
  id: string; name: string; badge: string | null; isFictitious: boolean;
  matricola: string | null; cognome: string | null; nome: string | null;
  cf: string | null; cellulare: string | null;
  residenzaAnagrafica: string | null; residenzaServizio: string | null;
  oreSettimanali: number | null; categoria: string | null;
  dataNascita: string | null; dataAssunzione: string | null; dataFineServizio: string | null;
  patente: string | null; patenteValidita: string | null;
  cqcNumero: string | null; cqcValidita: string | null;
  visitaMedicaValidita: string | null; note: string | null;
}

type Form = Partial<RosterDriver>;

const TEXT = "w-full px-2 py-1.5 text-sm rounded-md bg-slate-950 border border-slate-700 text-slate-100 focus:border-violet-500 focus:outline-none";
const LABEL = "block text-[11px] font-medium text-slate-400 mb-0.5";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className={LABEL}>{label}</span>{children}</label>;
}

export default function DriverEditDialog({ driver, onClose }: { driver: RosterDriver | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = !!driver;
  const [f, setF] = useState<Form>(driver ?? {});
  const set = (k: keyof RosterDriver, v: any) => setF((p) => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      const body = { ...f };
      return isEdit
        ? apiFetch(`/api/roster/drivers/${driver!.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : apiFetch(`/api/roster/drivers`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      toast.success(isEdit ? "Conducente aggiornato" : "Conducente creato");
      qc.invalidateQueries({ queryKey: ["roster"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSave = !!((f.cognome ?? "").trim() || (f.nome ?? "").trim() || (f.name ?? "").trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold">{isEdit ? "Modifica conducente" : "Nuovo conducente"}</div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5">
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2">Anagrafica</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="Matricola"><input className={TEXT} value={f.matricola ?? ""} onChange={(e) => set("matricola", e.target.value)} /></Field>
              <Field label="Cognome"><input className={TEXT} value={f.cognome ?? ""} onChange={(e) => set("cognome", e.target.value)} /></Field>
              <Field label="Nome"><input className={TEXT} value={f.nome ?? ""} onChange={(e) => set("nome", e.target.value)} /></Field>
              <Field label="Codice fiscale"><input className={TEXT} value={f.cf ?? ""} onChange={(e) => set("cf", e.target.value)} /></Field>
              <Field label="Data di nascita"><input type="date" className={TEXT} value={f.dataNascita ?? ""} onChange={(e) => set("dataNascita", e.target.value)} /></Field>
              <Field label="Cellulare"><input className={TEXT} value={f.cellulare ?? ""} onChange={(e) => set("cellulare", e.target.value)} /></Field>
            </div>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2">Residenza</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Residenza anagrafica"><input className={TEXT} value={f.residenzaAnagrafica ?? ""} onChange={(e) => set("residenzaAnagrafica", e.target.value)} /></Field>
              <Field label="Residenza di servizio"><input className={TEXT} value={f.residenzaServizio ?? ""} onChange={(e) => set("residenzaServizio", e.target.value)} /></Field>
            </div>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2">Rapporto di lavoro</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="Categoria conducente"><input className={TEXT} value={f.categoria ?? ""} onChange={(e) => set("categoria", e.target.value)} /></Field>
              <Field label="Ore settimanali"><input type="number" className={TEXT} value={f.oreSettimanali ?? ""} onChange={(e) => set("oreSettimanali", e.target.value === "" ? null : Number(e.target.value))} /></Field>
              <div />
              <Field label="Data assunzione"><input type="date" className={TEXT} value={f.dataAssunzione ?? ""} onChange={(e) => set("dataAssunzione", e.target.value)} /></Field>
              <Field label="Data fine servizio"><input type="date" className={TEXT} value={f.dataFineServizio ?? ""} onChange={(e) => set("dataFineServizio", e.target.value)} /></Field>
            </div>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2">Documenti e scadenze</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="Patente (categorie)"><input className={TEXT} value={f.patente ?? ""} onChange={(e) => set("patente", e.target.value)} placeholder="es. D, DE" /></Field>
              <Field label="Patente · validità"><input type="date" className={TEXT} value={f.patenteValidita ?? ""} onChange={(e) => set("patenteValidita", e.target.value)} /></Field>
              <div />
              <Field label="CQC · numero"><input className={TEXT} value={f.cqcNumero ?? ""} onChange={(e) => set("cqcNumero", e.target.value)} /></Field>
              <Field label="CQC · validità"><input type="date" className={TEXT} value={f.cqcValidita ?? ""} onChange={(e) => set("cqcValidita", e.target.value)} /></Field>
              <Field label="Visita medica · validità"><input type="date" className={TEXT} value={f.visitaMedicaValidita ?? ""} onChange={(e) => set("visitaMedicaValidita", e.target.value)} /></Field>
            </div>
          </section>

          <Field label="Note"><textarea className={TEXT} rows={2} value={f.note ?? ""} onChange={(e) => set("note", e.target.value)} /></Field>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-800">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Annulla</button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={!canSave || saveMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salva
          </button>
        </div>
      </div>
    </div>
  );
}
