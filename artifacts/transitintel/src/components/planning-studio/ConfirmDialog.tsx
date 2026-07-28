/**
 * Dialog di conferma in-app per il Planner Studio.
 *
 * Sostituisce window.confirm()/prompt(): i browser possono sopprimere i dialog
 * nativi ("impedisci altre finestre di dialogo") trasformando il click in un
 * no-op silenzioso — per le azioni distruttive è inaccettabile. In più questo
 * dialog può mostrare l'IMPATTO dell'azione (conteggi, avvisi) nel body.
 *
 * Uso (stato controllato dalla pagina):
 *   const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
 *   ...
 *   setConfirmReq({ title: "Eliminare la corsa?", message: "...", onConfirm: () => mut.mutate(id) });
 *   ...
 *   <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />
 *
 * onConfirm può essere async: il pulsante mostra lo spinner e il dialog si
 * chiude a promise risolta (su errore resta aperto — l'errore lo gestisce il
 * chiamante, tipicamente con un toast della mutation).
 */
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";

export interface ConfirmRequest {
  title: string;
  /** Corpo del dialog: testo o nodo ricco (conteggi, elenchi, avvisi). */
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger = azione distruttiva (rosso, default) · primary = azione importante non distruttiva */
  variant?: "danger" | "primary";
  onConfirm: () => void | Promise<void>;
}

export default function ConfirmDialog({
  req, onClose,
}: {
  req: ConfirmRequest | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, onClose]);

  useEffect(() => { setBusy(false); }, [req]);

  if (!req) return null;
  const danger = (req.variant ?? "danger") === "danger";

  const run = async () => {
    try {
      setBusy(true);
      await req.onConfirm();
      onClose();
    } catch {
      // L'errore è già gestito dal chiamante (toast della mutation):
      // il dialog resta aperto per riprovare o annullare.
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      onClick={(e) => { e.stopPropagation(); if (!busy) onClose(); }}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 py-4 border-b border-slate-800">
          <div className={`h-8 w-8 rounded-lg border flex items-center justify-center shrink-0 ${
            danger ? "bg-rose-500/15 border-rose-500/40" : "bg-sky-500/15 border-sky-500/40"
          }`}>
            <AlertTriangle className={`h-4 w-4 ${danger ? "text-rose-400" : "text-sky-300"}`} />
          </div>
          <h2 className="text-sm font-semibold leading-snug flex-1 pt-1">{req.title}</h2>
          <button
            onClick={onClose} disabled={busy}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {req.message && (
          <div className="px-5 py-4 text-sm text-slate-300 leading-relaxed">
            {req.message}
          </div>
        )}

        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-slate-800 bg-slate-950/40 rounded-b-2xl">
          <button
            onClick={onClose} disabled={busy}
            className="px-3.5 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            {req.cancelLabel ?? "Annulla"}
          </button>
          <button
            onClick={run} disabled={busy}
            className={`px-3.5 py-1.5 text-sm font-medium rounded-lg text-white flex items-center gap-1.5 disabled:opacity-60 ${
              danger ? "bg-rose-600 hover:bg-rose-500" : "bg-sky-600 hover:bg-sky-500"
            }`}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {req.confirmLabel ?? "Conferma"}
          </button>
        </div>
      </div>
    </div>
  );
}
