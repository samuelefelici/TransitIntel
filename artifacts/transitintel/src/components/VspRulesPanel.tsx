/**
 * VspRulesPanel — Pannello "Parametri & Regole" per i TURNI MACCHINA (VSP).
 * Gemello di OptimizerRulesPanel: stessa UX (accordion, badge modificato,
 * Avanzate, profili riusabili azienda/progetto) ma su VspConfig
 * { vehicleCosts, vspAdvanced } e profili domain='vsp'.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { X, RotateCcw, ChevronDown, Save, FolderOpen, Trash2, Star } from "lucide-react";
import { getByPath, setByPath, type GroupDef } from "@/lib/optimizer-rules";
import { VSP_GROUPS, buildDefaultVspConfig, type VspConfig } from "@/lib/vsp-rules";
import { FieldRow } from "@/components/OptimizerRulesPanel";
import {
  listRuleProfiles, createRuleProfile, deleteRuleProfile, updateRuleProfile,
  type RuleProfile,
} from "@/lib/rule-profiles-api";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  config: VspConfig;
  onChange: (cfg: VspConfig) => void;
  projectId?: string | null;
  /** false = nasconde i "Profili regole" interni (il salvataggio vive altrove,
   *  es. nella sezione "Algoritmo" dell'ottimizzatore — UNA sola sezione). */
  showProfiles?: boolean;
}

const DEFAULTS = buildDefaultVspConfig();

function isModified(cfg: any, path: string): boolean {
  const cur = getByPath(cfg, path);
  if (cur === undefined) return false;
  return JSON.stringify(cur) !== JSON.stringify(getByPath(DEFAULTS, path));
}
function countModified(cfg: any, g: GroupDef): number {
  return g.fields.filter((f) => isModified(cfg, f.path)).length;
}

export function VspRulesPanel({ isOpen, onClose, config, onChange, projectId, showProfiles = true }: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [profiles, setProfiles] = useState<RuleProfile[]>([]);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<"company" | "project">("company");
  const [newDefault, setNewDefault] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadProfiles = useCallback(() => {
    listRuleProfiles(projectId, "vsp").then(setProfiles).catch(() => setProfiles([]));
  }, [projectId]);
  useEffect(() => { if (isOpen) loadProfiles(); }, [isOpen, loadProfiles]);

  const setField = useCallback((path: string, value: any) => {
    onChange(setByPath(config as any, path, value));
  }, [config, onChange]);
  const resetField = useCallback((path: string) => {
    onChange(setByPath(config as any, path, getByPath(DEFAULTS, path)));
  }, [config, onChange]);
  const resetGroup = useCallback((g: GroupDef) => {
    let next: any = config;
    for (const f of g.fields) next = setByPath(next, f.path, getByPath(DEFAULTS, f.path));
    onChange(next);
  }, [config, onChange]);
  const resetAll = useCallback(() => onChange(buildDefaultVspConfig()), [onChange]);

  const totalModified = useMemo(
    () => VSP_GROUPS.reduce((s, g) => s + countModified(config, g), 0),
    [config],
  );
  const visibleGroups = useMemo(() => VSP_GROUPS.filter((g) => showAdvanced || !g.advanced), [showAdvanced]);

  const applyProfile = useCallback((p: RuleProfile) => {
    const base = buildDefaultVspConfig();
    onChange({
      vehicleCosts: { ...base.vehicleCosts, ...(p.config?.vehicleCosts ?? {}) },
      vspAdvanced: { ...base.vspAdvanced, ...(p.config?.vspAdvanced ?? {}) },
    });
    setProfilesOpen(false);
  }, [onChange]);

  const saveProfile = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await createRuleProfile({
        name: newName.trim(), scope: newScope, domain: "vsp",
        projectId: newScope === "project" ? projectId ?? null : null,
        config, isDefault: newDefault,
      });
      setNewName("");
      loadProfiles();
    } finally { setBusy(false); }
  }, [newName, newScope, projectId, config, newDefault, loadProfiles]);

  const removeProfile = useCallback(async (id: string) => {
    setBusy(true);
    try { await deleteRuleProfile(id); loadProfiles(); } finally { setBusy(false); }
  }, [loadProfiles]);
  const makeDefault = useCallback(async (p: RuleProfile) => {
    setBusy(true);
    try { await updateRuleProfile(p.id, { isDefault: true }); loadProfiles(); } finally { setBusy(false); }
  }, [loadProfiles]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-xl h-full bg-zinc-950 border-l border-zinc-800 shadow-2xl flex flex-col">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Parametri & Regole · Turni macchina</h2>
            <p className="text-[11px] text-zinc-500">
              Impostali prima del lancio · default = regole attuali
              {totalModified > 0 && <span className="text-amber-400"> · {totalModified} modificati</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-4 py-3 border-b border-zinc-800 space-y-3">
          <div className="flex items-center justify-between gap-2">
            {showProfiles && (
              <button
                onClick={() => setProfilesOpen((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-zinc-300 px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 hover:bg-zinc-800"
              >
                <FolderOpen className="w-3.5 h-3.5" /> Profili regole {profiles.length > 0 && `(${profiles.length})`}
              </button>
            )}
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
              <input type="checkbox" className="accent-indigo-500" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
              Mostra avanzate
            </label>
            <button onClick={resetAll} className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200">
              <RotateCcw className="w-3 h-3" /> Tutto ai default
            </button>
          </div>

          {showProfiles && profilesOpen && (
            <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2 space-y-2">
              {profiles.length === 0 && <div className="text-[11px] text-zinc-500">Nessun profilo salvato.</div>}
              {profiles.map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-xs">
                  <button onClick={() => applyProfile(p)} className="flex-1 text-left text-zinc-200 hover:text-indigo-300 truncate">
                    {p.isDefault && <Star className="inline w-3 h-3 text-amber-400 mr-1" />}
                    {p.name}
                    <span className="text-zinc-600"> · {p.scope === "company" ? "azienda" : "progetto"}</span>
                  </button>
                  {!p.isDefault && (
                    <button onClick={() => makeDefault(p)} disabled={busy} title="Imposta come default" className="text-zinc-500 hover:text-amber-400"><Star className="w-3.5 h-3.5" /></button>
                  )}
                  <button onClick={() => removeProfile(p.id)} disabled={busy} className="text-zinc-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
              <div className="border-t border-zinc-800 pt-2 space-y-1.5">
                <input
                  value={newName} onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nome nuovo profilo…"
                  className="w-full px-2 py-1 text-xs rounded bg-zinc-950 border border-zinc-700 text-zinc-100"
                />
                <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                  <select value={newScope} onChange={(e) => setNewScope(e.target.value as any)} className="px-1.5 py-1 rounded bg-zinc-950 border border-zinc-700 text-zinc-200">
                    <option value="company">Azienda</option>
                    <option value="project" disabled={!projectId}>Progetto</option>
                  </select>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="checkbox" className="accent-indigo-500" checked={newDefault} onChange={(e) => setNewDefault(e.target.checked)} /> default
                  </label>
                  <button onClick={saveProfile} disabled={busy || !newName.trim()} className="ml-auto flex items-center gap-1 px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
                    <Save className="w-3 h-3" /> Salva
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {visibleGroups.map((g) => {
            const mod = countModified(config, g);
            const isOpenGroup = open[g.id] ?? false;
            return (
              <div key={g.id} className="rounded border border-zinc-800 bg-zinc-900/40">
                <button onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpenGroup }))} className="w-full px-3 py-2 flex items-center justify-between text-left">
                  <div className="flex items-center gap-2">
                    <ChevronDown className={`w-4 h-4 text-zinc-500 transition ${isOpenGroup ? "" : "-rotate-90"}`} />
                    <span className="text-xs font-medium text-zinc-200">{g.title}</span>
                    {g.advanced && <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-500">avanzate</span>}
                  </div>
                  {mod > 0 && <span className="text-[10px] px-1.5 rounded-full bg-amber-500/20 text-amber-400">{mod}</span>}
                </button>
                {isOpenGroup && (
                  <div className="px-3 pb-3 space-y-2">
                    {g.description && <p className="text-[10px] text-zinc-500 leading-tight">{g.description}</p>}
                    <div className="flex justify-end">
                      <button onClick={() => resetGroup(g)} className="text-[10px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1">
                        <RotateCcw className="w-2.5 h-2.5" /> default gruppo
                      </button>
                    </div>
                    {g.fields.filter((f) => showAdvanced || !f.advanced).map((f) => (
                      <FieldRow
                        key={f.path}
                        field={f}
                        value={getByPath(config, f.path)}
                        modified={isModified(config, f.path)}
                        onChange={(v) => setField(f.path, v)}
                        onReset={() => resetField(f.path)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-between">
          <span className="text-[11px] text-zinc-500">{totalModified} modificati</span>
          <button onClick={onClose} className="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium">Fatto</button>
        </div>
      </div>
    </div>
  );
}
