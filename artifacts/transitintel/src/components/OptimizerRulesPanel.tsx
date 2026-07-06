/**
 * OptimizerRulesPanel — Pannello "Parametri & Regole" che l'operatore compila
 * PRIMA di lanciare l'ottimizzatore turni guida.
 *
 * Tutti i parametri partono dai default (= regole attuali) ma sono modificabili.
 * Driven dallo schema dichiarativo in lib/optimizer-rules (chiavi allineate al
 * solver Python). Supporta:
 *   - selettore tipo servizio (preset iniziale, tutto resta editabile)
 *   - badge "modificato vs default" per campo/gruppo + reset
 *   - sezione "Avanzate" per i parametri rischiosi
 *   - avvisi sui limiti normativi RD 131
 *   - profili-regole riusabili (azienda/progetto) via DB
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { X, RotateCcw, AlertTriangle, ChevronDown, Save, FolderOpen, Trash2, Star } from "lucide-react";
import type { OperatorConfig } from "@/hooks/use-crew-optimization";
import {
  RULE_GROUPS, SERVICE_PROFILES, buildDefaultConfig,
  getByPath, setByPath, defaultForPath, isModified, countModified,
  minToHHMM, hhmmToMin,
  type GroupDef, type FieldDef, type ServiceType,
} from "@/lib/optimizer-rules";
import {
  listRuleProfiles, createRuleProfile, deleteRuleProfile, updateRuleProfile,
  type RuleProfile,
} from "@/lib/rule-profiles-api";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  config: OperatorConfig;
  onChange: (cfg: OperatorConfig) => void;
  serviceType: ServiceType;
  onServiceTypeChange: (t: ServiceType) => void;
  /** progetto Planning Studio per lo scope dei profili (opzionale) */
  projectId?: string | null;
  /** false = nasconde i "Profili regole" interni (il salvataggio vive altrove,
   *  es. nella sezione "Algoritmo" dell'ottimizzatore VCSP). */
  showProfiles?: boolean;
}

const SERVICE_LABELS: { key: ServiceType; label: string }[] = [
  { key: "urbano", label: "Urbano" },
  { key: "extraurbano", label: "Extraurbano" },
  { key: "misto", label: "Misto" },
];

export function OptimizerRulesPanel({
  isOpen, onClose, config, onChange, serviceType, onServiceTypeChange, projectId, showProfiles = true,
}: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [profiles, setProfiles] = useState<RuleProfile[]>([]);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<"company" | "project">("company");
  const [newDefault, setNewDefault] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadProfiles = useCallback(() => {
    listRuleProfiles(projectId).then(setProfiles).catch(() => setProfiles([]));
  }, [projectId]);

  useEffect(() => { if (isOpen) loadProfiles(); }, [isOpen, loadProfiles]);

  const setField = useCallback((path: string, value: any) => {
    onChange(setByPath(config as any, path, value));
  }, [config, onChange]);

  const resetField = useCallback((path: string) => {
    onChange(setByPath(config as any, path, defaultForPath(path, serviceType)));
  }, [config, onChange, serviceType]);

  const resetGroup = useCallback((g: GroupDef) => {
    let next: any = config;
    for (const f of g.fields) next = setByPath(next, f.path, defaultForPath(f.path, serviceType));
    onChange(next);
  }, [config, onChange, serviceType]);

  const resetAll = useCallback(() => {
    onChange(buildDefaultConfig(serviceType));
  }, [onChange, serviceType]);

  const totalModified = useMemo(
    () => RULE_GROUPS.reduce((s, g) => s + countModified(config, g, serviceType), 0),
    [config, serviceType],
  );

  const visibleGroups = useMemo(
    () => RULE_GROUPS.filter((g) => showAdvanced || !g.advanced),
    [showAdvanced],
  );

  /* ── Profili ──────────────────────────────────────────────────────────── */
  const applyProfile = useCallback((p: RuleProfile) => {
    // merge sul default del servizio così i campi mancanti restano coerenti
    const base = buildDefaultConfig(serviceType);
    onChange({ ...base, ...p.config, bds: { ...base.bds, ...(p.config?.bds ?? {}) } } as OperatorConfig);
    if (p.serviceType && p.serviceType !== serviceType) onServiceTypeChange(p.serviceType as ServiceType);
    setProfilesOpen(false);
  }, [serviceType, onChange, onServiceTypeChange]);

  const saveProfile = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await createRuleProfile({
        name: newName.trim(),
        scope: newScope,
        projectId: newScope === "project" ? projectId ?? null : null,
        serviceType,
        config,
        isDefault: newDefault,
      });
      setNewName("");
      loadProfiles();
    } finally { setBusy(false); }
  }, [newName, newScope, projectId, serviceType, config, newDefault, loadProfiles]);

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
        {/* Header */}
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Parametri & Regole</h2>
            <p className="text-[11px] text-zinc-500">
              Impostali prima del lancio · default = regole attuali
              {totalModified > 0 && <span className="text-amber-400"> · {totalModified} modificati</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400"><X className="w-4 h-4" /></button>
        </div>

        {/* Tipo servizio + profili + avanzate */}
        <div className="px-4 py-3 border-b border-zinc-800 space-y-3">
          <div>
            <div className="text-[11px] text-zinc-500 mb-1.5">Tipo di ottimizzazione (preset iniziale)</div>
            <div className="flex gap-1.5">
              {SERVICE_LABELS.map((o) => (
                <button
                  key={o.key}
                  onClick={() => onServiceTypeChange(o.key)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-medium border transition ${
                    serviceType === o.key
                      ? "bg-indigo-500/20 border-indigo-500 text-indigo-200"
                      : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                  }`}
                >{o.label}</button>
              ))}
            </div>
          </div>

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
                    <span className="text-zinc-600"> · {p.scope === "company" ? "azienda" : "progetto"}{p.serviceType ? ` · ${p.serviceType}` : ""}</span>
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

        {/* Gruppi */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {visibleGroups.map((g) => {
            const mod = countModified(config, g, serviceType);
            const isOpenGroup = open[g.id] ?? false;
            return (
              <div key={g.id} className="rounded border border-zinc-800 bg-zinc-900/40">
                <button
                  onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpenGroup }))}
                  className="w-full px-3 py-2 flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-2">
                    <ChevronDown className={`w-4 h-4 text-zinc-500 transition ${isOpenGroup ? "" : "-rotate-90"}`} />
                    <span className="text-xs font-medium text-zinc-200">{g.title}</span>
                    {g.serviceTypeScoped && <span className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-500">per servizio</span>}
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
                        modified={isModified(config, f.path, serviceType)}
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

        {/* Footer */}
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-between">
          <span className="text-[11px] text-zinc-500">{SERVICE_LABELS.find((s) => s.key === serviceType)?.label} · {totalModified} modificati</span>
          <button onClick={onClose} className="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium">
            Fatto
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Riga campo ──────────────────────────────────────────────────────────── */
export function FieldRow({
  field, value, modified, onChange, onReset,
}: {
  field: FieldDef;
  value: any;
  modified: boolean;
  onChange: (v: any) => void;
  onReset: () => void;
}) {
  const normWarn = field.normative && modified;
  return (
    <div className="flex items-center gap-2">
      <label className="flex-1 text-[11px] text-zinc-300 flex items-center gap-1.5">
        {field.label}
        {normWarn && <AlertTriangle className="w-3 h-3 text-amber-500" />}
      </label>
      <div className="flex items-center gap-1.5">
        {field.type === "bool" ? (
          <input type="checkbox" className="accent-indigo-500" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        ) : field.type === "enum" ? (
          <select
            value={String(value ?? "")}
            onChange={(e) => {
              // enum numerici (es. solverIntensity "2") → int, così la chiave
              // arriva al Python col tipo atteso; enum stringa restano stringa.
              const v = e.target.value;
              onChange(/^-?\d+$/.test(v) ? Number(v) : v);
            }}
            className="px-1.5 py-1 text-xs rounded bg-zinc-950 border border-zinc-700 text-zinc-100 max-w-[200px]"
          >
            {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : field.type === "time" ? (
          <input
            type="time"
            value={minToHHMM(Number(value ?? 0))}
            onChange={(e) => onChange(hhmmToMin(e.target.value))}
            className={`px-1.5 py-1 text-xs rounded bg-zinc-950 border text-zinc-100 ${normWarn ? "border-amber-600" : "border-zinc-700"}`}
          />
        ) : (
          <input
            type="number"
            value={value ?? ""}
            min={field.min} max={field.max} step={field.step ?? (field.type === "float" ? 0.1 : 1)}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange(field.type === "float" ? n : Math.round(n));
            }}
            className={`w-20 px-1.5 py-1 text-xs rounded bg-zinc-950 border text-zinc-100 ${normWarn ? "border-amber-600" : "border-zinc-700"} ${modified ? "ring-1 ring-amber-500/40" : ""}`}
          />
        )}
        {field.unit && <span className="text-[10px] text-zinc-500 w-8">{field.unit}</span>}
        {modified
          ? <button onClick={onReset} title="Ripristina default" className="text-zinc-600 hover:text-zinc-300"><RotateCcw className="w-3 h-3" /></button>
          : <span className="w-3" />}
      </div>
    </div>
  );
}
