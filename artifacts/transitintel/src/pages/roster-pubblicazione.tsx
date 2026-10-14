/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PUBBLICAZIONE TURNI — il canale unico fra Scheduling Engine e Roster
 * ───────────────────────────────────────────────────────────────────────────
 * Si sceglie un programma (progetto Planning Studio) e un periodo; per ogni
 * Unità di Progettazione del programma la pagina propone i turni guida (in
 * esercizio, o quelli già pubblicati) e mostra in quali giorni del periodo
 * valgono. «Pubblica nel roster» li manda al roster: da lì in poi il roster
 * mostra e fa assegnare solo quelli (api-server routes/roster-pubblicazione.ts).
 *
 * Ripubblicando un periodo già vestito, le assegnazioni passano da sole ai
 * turni nuovi con lo stesso contenuto; le altre restano «da riassegnare».
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowRight, CalendarRange, CheckCircle2, History, Loader2, Send, Undo2, Users,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

/* ── Tipi (allineati a /api/roster/pubblicazioni/*) ── */
interface Programma { id: string; nome: string; inEsercizio: boolean; udp: number; ultimaPubblicazione: string | null }
interface Candidato {
  dssId: string; nome: string; versione: number; inEsercizio: boolean;
  superatoDa: string | null; datiSuperati: boolean; turni: number; creatoIl: string; progetto: string;
}
interface UdpAnteprima {
  id: string; nome: string; servizio: "urbano" | "extraurbano" | null;
  giorni: string[]; candidati: Candidato[]; proposta: string | null; scelta: string | null;
  pubblicatoOra: Array<{ dssId: string; nome: string | null; giorni: number }>;
  avvisi: string[];
}
interface Anteprima {
  programma: Programma;
  periodo: { dal: string; al: string; giorni: number };
  udp: UdpAnteprima[];
  giorniToccati: string[];
  giorniSenzaUdp: string[];
  giorniSenzaUdpPubblicati: string[];
  giorniPassati: string[];
  altriProgrammi: Array<{ nome: string; giorni: number }>;
  doppie: Array<{ giorni: string[]; dss: string[]; corse: number; esempio: string }>;
  impatto: {
    assegnazioni: number; restanoDove: number; ricollegate: number; daRiassegnare: number;
    motivi: Record<string, number>; passateSenzaRicollegare: number;
  };
  gettone: string;
}
interface Esito {
  id: string;
  riepilogo: { giorni: number; righe: number; sostituite: number; ricollegate: number; daRiassegnare: number; nuoveViolazioni: number; passateSenzaRicollegare: number };
  nuoveViolazioni: string[];
}
interface VoceRegistro {
  id: string; tipo: "pubblica" | "ritira"; psProjectId: string | null; programma: string | null;
  dal: string; al: string; riepilogo: Record<string, number>; nota: string | null; creataIl: string; autore: string | null;
}

/* ── Date ── */
const isoOggi = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date());
const piu = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const giorniFra = (dal: string, al: string): string[] => {
  const out: string[] = [];
  if (!dal || !al || al < dal) return out;
  for (let t = Date.parse(`${dal}T00:00:00Z`), f = Date.parse(`${al}T00:00:00Z`); t <= f && out.length < 400; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};
const breve = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.toLocaleDateString("it-IT", { weekday: "short", timeZone: "UTC" })} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
};
const lunga = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const quando = (iso: string) => new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const elenco = (xs: string[], n = 6) => `${xs.slice(0, n).map(breve).join(", ")}${xs.length > n ? ` e altri ${xs.length - n}` : ""}`;

const etichettaCandidato = (c: Candidato) =>
  `${c.inEsercizio ? "● " : ""}v${c.versione} · ${c.nome} · ${c.turni} turni${c.superatoDa ? " · c'è una versione più nuova" : ""}${c.datiSuperati ? " · dati cambiati" : ""}`;

const MOTIVI: Record<string, string> = {
  "nessun turno uguale": "nessun turno con le stesse corse e gli stessi orari",
  ambiguo: "più turni uguali: lo decide una persona",
  "turno illeggibile": "turno senza orari",
};

export default function RosterPubblicazionePage() {
  const qc = useQueryClient();
  const daUrl = useMemo(() => new URLSearchParams(window.location.search).get("psProjectId") ?? "", []);
  const oggi = isoOggi();
  const [psProjectId, setPsProjectId] = useState(daUrl);
  const [dal, setDal] = useState(oggi);
  const [al, setAl] = useState(piu(oggi, 27));
  /* null = le proposte del server; altrimenti le scelte fatte qui, per UDP */
  const [scelte, setScelte] = useState<Record<string, string | null> | null>(null);
  const [passato, setPassato] = useState(false);
  const [nota, setNota] = useState("");
  const [esito, setEsito] = useState<Esito | null>(null);

  const programmiQ = useQuery({
    queryKey: ["roster", "pubblicazione", "programmi"],
    queryFn: () => apiFetch<{ programmi: Programma[] }>("/api/roster/pubblicazioni/programmi").then(r => r.programmi),
  });
  /* senza programma indicato: quello in esercizio, o il primo */
  useEffect(() => {
    if (!psProjectId && programmiQ.data?.length) setPsProjectId(programmiQ.data[0]!.id);
  }, [programmiQ.data, psProjectId]);

  const periodoValido = /^\d{4}-\d{2}-\d{2}$/.test(dal) && /^\d{4}-\d{2}-\d{2}$/.test(al) && dal <= al;
  const anteprimaQ = useQuery({
    queryKey: ["roster", "pubblicazione", "anteprima", psProjectId, dal, al, scelte],
    queryFn: () => apiFetch<Anteprima>("/api/roster/pubblicazioni/anteprima", {
      method: "POST", body: JSON.stringify({ psProjectId, dal, al, ...(scelte ? { scelte } : {}) }),
    }),
    enabled: !!psProjectId && periodoValido,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const a = anteprimaQ.data;

  const registroQ = useQuery({
    queryKey: ["roster", "pubblicazione", "registro"],
    queryFn: () => apiFetch<{ pubblicazioni: VoceRegistro[] }>("/api/roster/pubblicazioni").then(r => r.pubblicazioni),
  });

  const sceltaDi = (u: UdpAnteprima) => (scelte && u.id in scelte ? scelte[u.id] ?? null : u.scelta);
  const scegli = (udpId: string, dssId: string | null) => {
    if (!a) return;
    const base: Record<string, string | null> = {};
    for (const u of a.udp) base[u.id] = sceltaDi(u);
    setScelte({ ...base, [udpId]: dssId });
    setEsito(null);
  };
  const cambiaProgramma = (id: string) => { setPsProjectId(id); setScelte(null); setEsito(null); };

  const bloccanti = (a?.udp ?? []).filter(u => sceltaDi(u) && u.avvisi.some(x => x.includes("codici ripetuti") || x.includes("non hanno turni")));
  const puoPubblicare = !!a && !anteprimaQ.isFetching && a.giorniToccati.length > 0 && !bloccanti.length && (!a.giorniPassati.length || passato);

  const pubblicaMut = useMutation({
    mutationFn: () => {
      const s: Record<string, string | null> = {};
      for (const u of a!.udp) s[u.id] = sceltaDi(u);
      return apiFetch<Esito>("/api/roster/pubblicazioni", {
        method: "POST",
        body: JSON.stringify({ psProjectId, dal, al, scelte: s, gettone: a!.gettone, passato, nota: nota.trim() || undefined }),
      });
    },
    onSuccess: (r) => {
      setEsito(r);
      setNota("");
      toast.success(`Pubblicati ${r.riepilogo.giorni} giorni nel roster`);
      qc.invalidateQueries({ queryKey: ["roster"] });
    },
    onError: (e: Error & { body?: any }) => {
      if (e.body?.cambiato) {
        toast.warning("Nel frattempo è cambiato qualcosa: ecco l'anteprima aggiornata. Ricontrolla e pubblica di nuovo.");
        qc.invalidateQueries({ queryKey: ["roster", "pubblicazione", "anteprima"] });
        return;
      }
      toast.error("Pubblicazione non riuscita", { description: e.message });
    },
  });

  /* ritiro di un periodo: il roster quei giorni non ha più turni del programma */
  const [ritiroAperto, setRitiroAperto] = useState(false);
  const [ritiroDal, setRitiroDal] = useState(oggi);
  const [ritiroAl, setRitiroAl] = useState(oggi);
  const ritiraMut = useMutation({
    mutationFn: () => apiFetch<{ righe: number; giorni: number }>("/api/roster/pubblicazioni/ritira", {
      method: "POST", body: JSON.stringify({ dal: ritiroDal, al: ritiroAl, psProjectId, passato: ritiroDal < oggi }),
    }),
    onSuccess: (r) => {
      toast.success(`Ritirati dal roster ${r.giorni} giorni`);
      setRitiroAperto(false);
      qc.invalidateQueries({ queryKey: ["roster"] });
    },
    onError: (e: Error) => toast.error("Ritiro non riuscito", { description: e.message }),
  });

  const periodo = useMemo(() => giorniFra(dal, al), [dal, al]);
  const programma = programmiQ.data?.find(p => p.id === psProjectId);

  return (
    <div className="flex flex-col min-h-screen bg-slate-950 text-slate-100">
      {/* ── Testata ── */}
      <div className="border-b border-slate-800 bg-slate-900 px-4 py-3 flex flex-wrap items-center gap-3">
        <Send className="w-5 h-5 text-violet-400" />
        <div className="min-w-0">
          <h1 className="font-bold text-sm">Pubblicazione turni</h1>
          <p className="text-[11px] text-slate-400">Dallo Scheduling Engine al Roster: per ogni periodo, quali turni guida arrivano. Il roster riceve solo da qui.</p>
        </div>
        <Link href="/roster" className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs">
          <Users className="w-3.5 h-3.5" /> Apri il roster
        </Link>
      </div>

      {/* ── Programma e periodo ── */}
      <div className="border-b border-slate-800 bg-slate-900/60 px-4 py-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="pub-programma" className="text-[10px] uppercase tracking-wide text-slate-400">Programma</label>
          <select id="pub-programma" value={psProjectId} onChange={e => cambiaProgramma(e.target.value)}
            className="min-w-64 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-sm focus:border-violet-500 focus:outline-none">
            {!programmiQ.data?.length && <option value="">{programmiQ.isLoading ? "Carico…" : "Nessun programma visibile"}</option>}
            {programmiQ.data?.map(p => (
              <option key={p.id} value={p.id}>{p.inEsercizio ? "● " : ""}{p.nome} · {p.udp} UDP</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="pub-dal" className="text-[10px] uppercase tracking-wide text-slate-400">Dal</label>
          <input id="pub-dal" type="date" value={dal} onChange={e => { setDal(e.target.value); setEsito(null); }}
            className="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-sm focus:border-violet-500 focus:outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="pub-al" className="text-[10px] uppercase tracking-wide text-slate-400">Al</label>
          <input id="pub-al" type="date" value={al} onChange={e => { setAl(e.target.value); setEsito(null); }}
            className="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-sm focus:border-violet-500 focus:outline-none" />
        </div>
        <div className="flex items-center gap-1 pb-0.5">
          {([["4 settimane", 27], ["8 settimane", 55], ["3 mesi", 90]] as const).map(([t, n]) => (
            <button key={t} onClick={() => { setAl(piu(dal, n)); setEsito(null); }}
              className="px-2 py-1 rounded-md text-[11px] text-slate-300 border border-slate-700 hover:bg-slate-800">{t}</button>
          ))}
        </div>
        <span className="pb-1.5 text-[11px] text-slate-500">{periodoValido ? `${periodo.length} giorni` : "periodo non valido"}</span>
        {anteprimaQ.isFetching && <Loader2 className="w-4 h-4 animate-spin text-violet-400 mb-1.5" />}
      </div>

      <div className="flex-1 grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4 p-4 items-start">
        {/* ── Le UDP del programma ── */}
        <section className="min-w-0 space-y-2" aria-label="Unità di Progettazione">
          {anteprimaQ.isError && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {(anteprimaQ.error as Error).message}
            </div>
          )}
          {a && !a.udp.length && (
            <div className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">
              Il programma non ha Unità di Progettazione: calcolale in Planning Studio (Validità → Calcola unità).
            </div>
          )}
          {a?.udp.map(u => {
            const scelta = sceltaDi(u);
            const dateUdp = new Set(u.giorni);
            return (
              <div key={u.id} className={`rounded-xl border p-3 ${scelta ? "border-slate-700 bg-slate-900" : "border-slate-800 bg-slate-900/40"}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm truncate">{u.nome}</span>
                      {u.servizio && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${u.servizio === "urbano" ? "bg-sky-500/15 text-sky-200" : "bg-amber-500/15 text-amber-200"}`}>
                          {u.servizio}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {u.giorni.length ? `${u.giorni.length} giorni nel periodo` : "nessun giorno nel periodo"}
                      {u.pubblicatoOra.length > 0 && (
                        <> · ora pubblicato: {u.pubblicatoOra.map(p => `${p.nome ?? "turni guida"} (${p.giorni} gg)`).join(", ")}</>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 w-full sm:w-auto sm:min-w-80">
                    <label htmlFor={`pub-udp-${u.id}`} className="sr-only">Turni guida da pubblicare per {u.nome}</label>
                    <select id={`pub-udp-${u.id}`} value={scelta ?? ""} onChange={e => scegli(u.id, e.target.value || null)}
                      className="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs focus:border-violet-500 focus:outline-none">
                      <option value="">— non pubblicare —</option>
                      {u.candidati.map(c => <option key={c.dssId} value={c.dssId}>{etichettaCandidato(c)}</option>)}
                    </select>
                    {scelta && scelta !== u.proposta && u.proposta && (
                      <button onClick={() => scegli(u.id, u.proposta)} className="self-end text-[10px] text-slate-400 underline hover:no-underline">torna alla proposta</button>
                    )}
                  </div>
                </div>
                {/* i giorni del periodo in cui vale questa UDP */}
                {periodo.length > 0 && (
                  <div className="mt-2 flex gap-px h-2.5 rounded overflow-hidden" aria-hidden title={u.giorni.length ? elenco(u.giorni) : "nessun giorno"}>
                    {periodo.map(g => (
                      <span key={g} className={`flex-1 ${dateUdp.has(g) ? (scelta ? "bg-violet-500" : "bg-slate-600") : "bg-slate-800/70"}`} />
                    ))}
                  </div>
                )}
                {u.avvisi.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {u.avvisi.map(x => (
                      <li key={x} className="flex items-start gap-1.5 text-[11px] text-amber-200"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {x}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </section>

        {/* ── Cosa succede, e il pulsante ── */}
        <aside className="space-y-3 xl:sticky xl:top-4">
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-3">
            <h2 className="text-sm font-semibold flex items-center gap-2"><CalendarRange className="w-4 h-4 text-violet-400" /> Cosa succede</h2>
            {!a ? (
              <p className="text-xs text-slate-400">{anteprimaQ.isFetching ? "Calcolo…" : "Scegli programma e periodo."}</p>
            ) : (
              <>
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-slate-400">Giorni pubblicati</dt>
                  <dd className="font-semibold tabular-nums text-right">{a.giorniToccati.length} / {a.periodo.giorni}</dd>
                  <dt className="text-slate-400">Assegnazioni nel periodo</dt>
                  <dd className="tabular-nums text-right">{a.impatto.assegnazioni}</dd>
                  <dt className="text-slate-400 pl-3">restano dove sono</dt>
                  <dd className="tabular-nums text-right">{a.impatto.restanoDove}</dd>
                  <dt className="text-slate-400 pl-3">passano ai turni nuovi uguali</dt>
                  <dd className="tabular-nums text-right text-emerald-300">{a.impatto.ricollegate}</dd>
                  <dt className="text-slate-400 pl-3">da riassegnare</dt>
                  <dd className={`tabular-nums text-right ${a.impatto.daRiassegnare ? "text-amber-300 font-semibold" : ""}`}>{a.impatto.daRiassegnare}</dd>
                </dl>
                {Object.entries(a.impatto.motivi).length > 0 && (
                  <ul className="text-[11px] text-slate-400 space-y-0.5">
                    {Object.entries(a.impatto.motivi).map(([m, n]) => <li key={m}>{n} · {MOTIVI[m] ?? m}</li>)}
                  </ul>
                )}
                <div className="space-y-1.5 text-[11px]">
                  {a.giorniSenzaUdp.length > 0 && (
                    <p className="text-amber-200">
                      {a.giorniSenzaUdp.length} giorni senza UDP scelte ({elenco(a.giorniSenzaUdp, 4)}): restano come sono
                      {a.giorniSenzaUdpPubblicati.length > 0 ? `, ${a.giorniSenzaUdpPubblicati.length} con i turni pubblicati prima` : ", senza turni"}.
                    </p>
                  )}
                  {a.altriProgrammi.map(p => (
                    <p key={p.nome} className="text-amber-200">Sostituisce «{p.nome}» in {p.giorni} giorni.</p>
                  ))}
                  {a.doppie.map(d => (
                    <p key={d.dss.join()} className="text-rose-200">
                      {d.corse} corse stanno in due turni pubblicati ({d.dss.join(" e ")}) in {d.giorni.length} giorni: verrebbero coperte due volte.
                    </p>
                  ))}
                  {a.impatto.passateSenzaRicollegare > 0 && (
                    <p className="text-slate-400">{a.impatto.passateSenzaRicollegare} assegnazioni di giorni passati non si spostano.</p>
                  )}
                </div>
                {a.giorniPassati.length > 0 && (
                  <label className="flex items-start gap-2 text-[11px] text-slate-300">
                    <input type="checkbox" checked={passato} onChange={e => setPassato(e.target.checked)} className="mt-0.5 accent-violet-500" />
                    <span>Pubblica anche {a.giorniPassati.length} giorni già passati (le loro assegnazioni non si spostano)</span>
                  </label>
                )}
                <div>
                  <label htmlFor="pub-nota" className="text-[10px] uppercase tracking-wide text-slate-400">Nota (facoltativa)</label>
                  <input id="pub-nota" value={nota} onChange={e => setNota(e.target.value)} maxLength={500} placeholder="es. cambio orario invernale"
                    className="mt-1 w-full px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs focus:border-violet-500 focus:outline-none" />
                </div>
                {bloccanti.length > 0 && (
                  <p className="text-[11px] text-rose-200">Da sistemare prima: {bloccanti.map(u => u.nome).join(", ")}.</p>
                )}
                <button onClick={() => pubblicaMut.mutate()} disabled={!puoPubblicare || pubblicaMut.isPending}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed">
                  {pubblicaMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Pubblica nel roster
                </button>
                <p className="text-[10px] text-slate-500">
                  {programma?.nome ?? "Il programma"} · dal {lunga(dal)} al {lunga(al)}. Nei giorni pubblicati il roster mostra solo questi turni guida.
                </p>
              </>
            )}
          </div>

          {esito && (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-1.5 text-xs" role="status">
              <div className="font-semibold text-emerald-200 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Pubblicato</div>
              <p>{esito.riepilogo.giorni} giorni nel roster · {esito.riepilogo.ricollegate} assegnazioni passate ai turni nuovi · {esito.riepilogo.daRiassegnare} da riassegnare.</p>
              {esito.nuoveViolazioni.length > 0 && (
                <div className="text-amber-200">
                  <p>{esito.riepilogo.nuoveViolazioni} assegnazioni passate ai turni nuovi hanno un riposo troppo corto o si sovrappongono:</p>
                  <ul className="list-disc pl-4">{esito.nuoveViolazioni.slice(0, 5).map(t => <li key={t}>{t}</li>)}</ul>
                </div>
              )}
              <Link href="/roster" className="inline-flex items-center gap-1 text-emerald-200 underline hover:no-underline">Vai al roster <ArrowRight className="w-3 h-3" /></Link>
            </div>
          )}

          {/* ── Ritiro ── */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs">
            <button onClick={() => setRitiroAperto(v => !v)} className="inline-flex items-center gap-1.5 text-slate-300 hover:text-slate-100" aria-expanded={ritiroAperto}>
              <Undo2 className="w-3.5 h-3.5" /> Ritira dal roster un periodo
            </button>
            {ritiroAperto && (
              <div className="mt-2 space-y-2">
                <p className="text-[11px] text-slate-400">I giorni ritirati restano senza turni di questo programma; le assegnazioni restano, da togliere o riassegnare.</p>
                <div className="flex gap-2">
                  <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-slate-400">Dal
                    <input type="date" value={ritiroDal} onChange={e => setRitiroDal(e.target.value)} className="px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs normal-case tracking-normal text-slate-100" />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-slate-400">Al
                    <input type="date" value={ritiroAl} onChange={e => setRitiroAl(e.target.value)} className="px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs normal-case tracking-normal text-slate-100" />
                  </label>
                </div>
                <button disabled={!psProjectId || ritiroAl < ritiroDal || ritiraMut.isPending}
                  onClick={() => { if (confirm(`Ritirare dal roster i turni di ${programma?.nome ?? "questo programma"} dal ${lunga(ritiroDal)} al ${lunga(ritiroAl)}?`)) ritiraMut.mutate(); }}
                  className="px-2.5 py-1.5 rounded-lg border border-rose-500/50 text-rose-200 hover:bg-rose-500/10 disabled:opacity-50">
                  Ritira
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* ── Registro ── */}
      <section className="px-4 pb-6" aria-label="Registro delle pubblicazioni">
        <h2 className="text-sm font-semibold flex items-center gap-2 mb-2"><History className="w-4 h-4 text-slate-400" /> Registro</h2>
        {!registroQ.data?.length ? (
          <p className="text-xs text-slate-500">{registroQ.isLoading ? "Carico…" : "Ancora nessuna pubblicazione."}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Quando</th>
                  <th className="text-left font-medium px-3 py-2">Cosa</th>
                  <th className="text-left font-medium px-3 py-2">Programma</th>
                  <th className="text-left font-medium px-3 py-2">Periodo</th>
                  <th className="text-right font-medium px-3 py-2">Giorni</th>
                  <th className="text-right font-medium px-3 py-2">Ricollegate</th>
                  <th className="text-right font-medium px-3 py-2">Da riassegnare</th>
                  <th className="text-left font-medium px-3 py-2">Chi</th>
                </tr>
              </thead>
              <tbody>
                {registroQ.data.map(v => (
                  <tr key={v.id} className="border-t border-slate-800">
                    <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{quando(v.creataIl)}</td>
                    <td className="px-3 py-1.5">{v.tipo === "ritira" ? <span className="text-rose-300">ritiro</span> : "pubblicazione"}{v.nota ? <span className="text-slate-500"> · {v.nota}</span> : null}</td>
                    <td className="px-3 py-1.5">{v.programma ?? "—"}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{lunga(v.dal)} – {lunga(v.al)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{v.riepilogo.giorni ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{v.riepilogo.ricollegate ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{v.riepilogo.daRiassegnare ?? "—"}</td>
                    <td className="px-3 py-1.5 text-slate-400">{v.autore ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
