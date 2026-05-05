/**
 * ShareScheduleDialog — modale riusabile per gestire i membri di un
 * VehicleSchedule (turni macchina) o DriverSchedule (turni guida).
 *
 * Stesso pattern di ShareProjectDialog ma agisce sulle nuove tabelle
 * vehicle_schedule_members / driver_schedule_members tramite
 * `schedule-shares-api.ts`.
 *
 * Props:
 *   - kind: "vehicle" | "driver"
 *   - id: id del VS o DS
 *   - canManage: solo l'owner può aggiungere/rimuovere membri
 */
import { useEffect, useMemo, useState } from "react";
import {
  X, Users, Search, Loader2, Trash2, Check, Shield, UserPlus, Truck,
} from "lucide-react";
import { toast } from "sonner";
import { lookupUsers, type UserLookup } from "@/lib/scheduling-projects-api";
import {
  listVehicleScheduleMembers, addVehicleScheduleMember, removeVehicleScheduleMember,
  listDriverScheduleMembers, addDriverScheduleMember, removeDriverScheduleMember,
  type ScheduleMember,
} from "@/lib/schedule-shares-api";

export type ShareKind = "vehicle" | "driver";

interface Props {
  kind: ShareKind;
  /** id del VehicleSchedule o DriverSchedule */
  id: string;
  /** nome breve mostrato nell'header (es. nome dello scenario) */
  scheduleName?: string;
  open: boolean;
  onClose: () => void;
  /** true → l'utente corrente è owner e può modificare la membership */
  canManage: boolean;
  /** chiamato dopo ogni mutation (per refresh delle liste a monte) */
  onChange?: () => void;
}

const API = {
  vehicle: {
    list: listVehicleScheduleMembers,
    add: addVehicleScheduleMember,
    remove: removeVehicleScheduleMember,
  },
  driver: {
    list: listDriverScheduleMembers,
    add: addDriverScheduleMember,
    remove: removeDriverScheduleMember,
  },
} as const;

const LABEL = {
  vehicle: { title: "Condividi turni macchina", noun: "scenario vetture", color: "amber" },
  driver:  { title: "Condividi turni guida",    noun: "turno guida",      color: "purple" },
} as const;

export default function ShareScheduleDialog({
  kind, id, scheduleName, open, onClose, canManage, onChange,
}: Props) {
  const api = API[kind];
  const meta = LABEL[kind];

  const [members, setMembers] = useState<ScheduleMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserLookup[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  // Carica membri all'apertura
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    api.list(id)
      .then(m => { if (!cancelled) setMembers(m); })
      .catch(e => toast.error(e?.message || "Impossibile caricare i membri"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, id, api]);

  // Search debounced
  useEffect(() => {
    if (!open || !canManage) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const u = await lookupUsers(query.trim());
        setResults(u);
      } catch {
        // silenzioso
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, open, canManage]);

  const memberIds = useMemo(() => new Set(members.map(m => m.userId)), [members]);

  async function handleAdd(u: UserLookup) {
    setBusyUserId(u.id);
    try {
      await api.add(id, u.id, "editor");
      // refetch per avere addedAt e fullName aggiornati
      const m = await api.list(id);
      setMembers(m);
      toast.success(`${u.email} aggiunto`);
      onChange?.();
    } catch (e: any) {
      toast.error(e?.message || "Impossibile aggiungere il membro");
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleRemove(m: ScheduleMember) {
    if (m.role === "owner") return;
    if (!confirm(`Rimuovere ${m.email ?? m.userId}?`)) return;
    setBusyUserId(m.userId);
    try {
      await api.remove(id, m.userId);
      setMembers(prev => prev.filter(x => x.userId !== m.userId));
      toast.success("Membro rimosso");
      onChange?.();
    } catch (e: any) {
      toast.error(e?.message || "Impossibile rimuovere il membro");
    } finally {
      setBusyUserId(null);
    }
  }

  if (!open) return null;

  const accentBorder = meta.color === "amber" ? "border-amber-500/30" : "border-purple-500/30";
  const accentShadow = meta.color === "amber"
    ? "shadow-[0_0_40px_rgba(251,191,36,0.15)]"
    : "shadow-[0_0_40px_rgba(168,85,247,0.15)]";
  const accentBg = meta.color === "amber" ? "bg-amber-500/15 border-amber-500/30" : "bg-purple-500/15 border-purple-500/30";
  const accentText = meta.color === "amber" ? "text-amber-300" : "text-purple-300";
  const accentIcon = meta.color === "amber" ? "text-amber-400" : "text-purple-400";

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className={`w-full max-w-xl rounded-2xl border ${accentBorder} bg-gradient-to-br from-zinc-950 to-black ${accentShadow} flex flex-col max-h-[85vh]`}>
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-zinc-800/50">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-9 h-9 rounded-lg ${accentBg} border flex items-center justify-center shrink-0`}>
              {kind === "vehicle"
                ? <Truck className={`w-4.5 h-4.5 ${accentIcon}`} />
                : <Users className={`w-4.5 h-4.5 ${accentIcon}`} />}
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-zinc-100">{meta.title}</h3>
              <p className="text-[11px] text-zinc-500 truncate">
                {scheduleName ? <span className="text-zinc-300 font-mono">{scheduleName}</span> : `Membri del ${meta.noun}.`}
                {canManage ? "" : " — solo l'owner può modificare."}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-100 p-1 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Membri */}
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">
              Membri ({members.length})
            </p>
            {loading ? (
              <div className="flex items-center justify-center py-6 text-zinc-600 text-xs">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Caricamento…
              </div>
            ) : members.length === 0 ? (
              <p className="text-xs text-zinc-500 italic px-3 py-4 rounded-lg border border-zinc-800/60 bg-black/30">
                Nessun membro. {canManage ? "Aggiungi colleghi qui sotto." : ""}
              </p>
            ) : (
              <div className="rounded-lg border border-zinc-800/60 bg-black/30 divide-y divide-zinc-800/60">
                {members.map(m => (
                  <div key={m.userId} className="flex items-center justify-between px-3 py-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                        m.role === "owner"
                          ? "bg-amber-500/20 border border-amber-500/40 text-amber-300"
                          : "bg-cyan-500/15 border border-cyan-500/30 text-cyan-300"
                      }`}>
                        {(m.fullName || m.email || m.userId).slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-zinc-100 truncate">{m.fullName || m.email || m.userId}</p>
                        <p className="text-[10px] text-zinc-500 truncate font-mono">{m.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        m.role === "owner" ? "bg-amber-500/15 text-amber-300" :
                        m.role === "editor" ? "bg-emerald-500/15 text-emerald-300" :
                        "bg-zinc-700/50 text-zinc-400"
                      }`}>
                        {m.role === "owner"
                          ? <span className="inline-flex items-center gap-1"><Shield className="w-2.5 h-2.5" /> owner</span>
                          : m.role}
                      </span>
                      {canManage && m.role !== "owner" && (
                        <button onClick={() => handleRemove(m)} disabled={busyUserId === m.userId}
                          className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50">
                          {busyUserId === m.userId
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Search & add — solo owner */}
          {canManage && (
            <section>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">
                Aggiungi collaboratori
              </p>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Cerca per email o nome…"
                  className={`w-full pl-9 pr-3 py-2 rounded-lg bg-black/60 border border-zinc-800 focus:${accentBorder} outline-none text-sm text-zinc-100 placeholder:text-zinc-600`}
                />
              </div>
              <div className="mt-2 rounded-lg border border-zinc-800/60 bg-black/30 max-h-56 overflow-y-auto">
                {searching ? (
                  <div className="flex items-center justify-center py-5 text-zinc-600 text-xs">
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> Ricerca…
                  </div>
                ) : results.length === 0 ? (
                  <div className="py-5 text-center text-xs text-zinc-600">
                    {query ? "Nessun utente trovato." : "Inizia a digitare per cercare."}
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-800/50">
                    {results.map(u => {
                      const already = memberIds.has(u.id);
                      return (
                        <div key={u.id} className="flex items-center justify-between px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-xs text-zinc-100 truncate">{u.fullName || u.email}</p>
                            <p className="text-[10px] text-zinc-500 truncate font-mono">{u.email}</p>
                          </div>
                          {already ? (
                            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-mono">
                              <Check className="w-3 h-3" /> membro
                            </span>
                          ) : (
                            <button onClick={() => handleAdd(u)} disabled={busyUserId === u.id}
                              className={`inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded border ${accentBorder} ${accentBg} ${accentText} hover:opacity-90 transition-opacity disabled:opacity-50`}>
                              {busyUserId === u.id
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : <UserPlus className="w-3 h-3" />}
                              Aggiungi
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800/50 flex justify-end">
          <button onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-lg text-zinc-300 bg-zinc-800/60 hover:bg-zinc-800 transition-colors">
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
