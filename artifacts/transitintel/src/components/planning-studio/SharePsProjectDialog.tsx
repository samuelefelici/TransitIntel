/**
 * SharePsProjectDialog — modale per condividere un progetto Planning Studio.
 *
 * Riusa il pattern di ShareProjectDialog (scheduling) ma chiama gli endpoint
 * /api/planning-studio/projects/:id/members (POST/GET/DELETE).
 *
 * Solo l'owner può modificare la membership; gli altri vedono la lista in read-only.
 */
import React, { useEffect, useMemo, useState } from "react";
import { X, Users, Search, Loader2, Trash2, Check, Shield, UserPlus } from "lucide-react";
import { toast } from "sonner";
import {
  listPsMembers, addPsMember, removePsMember,
  type PsMember,
} from "@/lib/planning-studio-api";
import { lookupUsers, type UserLookup } from "@/lib/scheduling-projects-api";

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
  /** true → l'utente corrente è owner del progetto e può aggiungere/rimuovere membri */
  canManage: boolean;
  /** chiamato dopo ogni mutation per consentire al parent di refresh il proprio stato */
  onChange?: () => void;
}

export default function SharePsProjectDialog({ projectId, open, onClose, canManage, onChange }: Props) {
  const [members, setMembers] = useState<PsMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserLookup[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  async function reloadMembers() {
    setLoading(true);
    try {
      const m = await listPsMembers(projectId);
      setMembers(m);
    } catch (e: any) {
      toast.error(e?.message || "Impossibile caricare i membri");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void reloadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  // Search debounced
  useEffect(() => {
    if (!open || !canManage) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const u = await lookupUsers(query.trim());
        setResults(u);
      } catch {
        /* silenzioso */
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
      await addPsMember(projectId, u.id, "editor");
      toast.success(`${u.email} aggiunto al progetto`);
      await reloadMembers();
      onChange?.();
    } catch (e: any) {
      toast.error(e?.message || "Impossibile aggiungere il membro");
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleRemove(m: PsMember) {
    if (m.role === "owner") return;
    if (!confirm(`Rimuovere ${m.email || m.fullName || "questo utente"} dal progetto?`)) return;
    setBusyUserId(m.userId);
    try {
      await removePsMember(projectId, m.userId);
      setMembers(prev => prev.filter(x => x.userId !== m.userId));
      toast.success("Membro rimosso");
      onChange?.();
    } catch (e: any) {
      toast.error(e?.message || "Impossibile rimuovere il membro");
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleChangeRole(m: PsMember, newRole: "editor" | "viewer") {
    if (m.role === "owner" || m.role === newRole) return;
    setBusyUserId(m.userId);
    try {
      await addPsMember(projectId, m.userId, newRole); // UPSERT
      setMembers(prev => prev.map(x => x.userId === m.userId ? { ...x, role: newRole } : x));
      toast.success(`Ruolo aggiornato a ${newRole}`);
      onChange?.();
    } catch (e: any) {
      toast.error(e?.message || "Impossibile aggiornare il ruolo");
    } finally {
      setBusyUserId(null);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-zinc-950 to-black shadow-[0_0_40px_rgba(34,211,238,0.15)] flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-zinc-800/50">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
              <Users className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <h3 className="text-base font-bold text-zinc-100">Condividi progetto</h3>
              <p className="text-[11px] text-zinc-500">
                {canManage
                  ? "Aggiungi colleghi che potranno collaborare a questo progetto."
                  : "Vedi l'elenco dei collaboratori. Solo l'owner può modificarlo."}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-100 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Membri attuali */}
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">
              Membri ({members.length})
            </p>
            {loading ? (
              <div className="flex items-center justify-center py-6 text-zinc-600 text-xs">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Caricamento…
              </div>
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
                        {(m.fullName || m.email || "??").slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-zinc-100 truncate">{m.fullName || m.email}</p>
                        <p className="text-[10px] text-zinc-500 truncate font-mono">{m.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {canManage && m.role !== "owner" ? (
                        <select
                          value={m.role}
                          disabled={busyUserId === m.userId}
                          onChange={e => handleChangeRole(m, e.target.value as "editor" | "viewer")}
                          className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-200 hover:border-cyan-500/50 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                        >
                          <option value="editor">editor</option>
                          <option value="viewer">viewer</option>
                        </select>
                      ) : (
                        <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${
                          m.role === "owner" ? "bg-amber-500/15 text-amber-300" :
                          m.role === "editor" ? "bg-emerald-500/15 text-emerald-300" :
                          "bg-zinc-700/50 text-zinc-400"
                        }`}>
                          {m.role === "owner"
                            ? <span className="inline-flex items-center gap-1"><Shield className="w-2.5 h-2.5" /> owner</span>
                            : m.role}
                        </span>
                      )}
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
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-black/60 border border-zinc-800 focus:border-cyan-500/50 outline-none text-sm text-zinc-100 placeholder:text-zinc-600"
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
                              className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 transition-colors disabled:opacity-50">
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
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200">
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
