/**
 * Vestizione per deposito, oggi e domani (tappa 5.2): la pagina del capo
 * deposito. I turni del deposito in ordine di uscita, con chi li fa; quelli da
 * coprire in cima (scoperti, e liberati da un'assenza) coi sostituti
 * suggeriti (5.1) e «Assegna»; i conducenti del deposito per gruppo; l'ordine
 * di servizio da stampare.
 *
 * Nessuna API nuova: legge il tabellone del roster dei due giorni e assegna
 * con la chiamata di sempre, quindi i controlli (riposi, sovrapposizioni,
 * depositi che si vedono e che si scrivono) restano quelli del tabellone. I
 * conti stanno in lib/vestizione.ts.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bus, CalendarClock, Printer, RefreshCw, UserCheck, Users } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { oggiARoma } from "@/lib/oggi";
import { GRUPPI, ordineDiServizio, vestizione, type TabelloneVestizione, type TurnoDelGiorno } from "@/lib/vestizione";
import { mezziDi, type MezziDelGiorno } from "@/lib/mezzi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Deposito { codice: string; nome: string; colore: string }
type Tabellone = TabelloneVestizione & { days: string[]; depositi?: Deposito[] };
interface Sostituti {
  deposito: string | null;
  titolare: { id: string; nome: string | null; assente: boolean } | null;
  sostituti: Array<{ id: string; nome: string; gruppo: "libero" | "disposizione" | "in_servizio"; turni: string[] }>;
  fuori: { assenti: number; violazioni: number };
}

const piuUno = (g: string) => new Date(Date.parse(`${g}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const giornoLungo = (g: string) => new Date(`${g}T12:00:00`).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
const selectCls = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const GRUPPO_SOSTITUTO = { libero: "libero", disposizione: "a disposizione", in_servizio: "in servizio" } as const;
const STATO: Record<TurnoDelGiorno["stato"], { testo: string; cls: string }> = {
  scoperto: { testo: "da coprire", cls: "text-amber-300" },
  liberato: { testo: "da coprire · titolare assente", cls: "text-rose-300" },
  coperto: { testo: "coperto", cls: "text-emerald-300" },
  altro_deposito: { testo: "coperto da un altro deposito", cls: "text-muted-foreground" },
};

export default function VestizionePage() {
  const { user, puo, azienda } = useAuth();
  const scrive = puo("roster", "S");
  const qc = useQueryClient();
  const oggi = oggiARoma();
  const domani = piuUno(oggi);
  const [giorno, setGiorno] = useState(oggi);
  const [deposito, setDeposito] = useState<string | null>(null);
  const [aperto, setAperto] = useState<string | null>(null);
  const [messaggio, setMessaggio] = useState<{ tipo: "ok" | "errore"; testo: string } | null>(null);

  const tabellone = useQuery({
    queryKey: ["vestizione", oggi],
    queryFn: () => apiFetch<Tabellone>(`/api/roster/board?from=${oggi}&days=2`),
    refetchInterval: 120_000,
  });
  const depositi = useMemo(() => {
    const b = tabellone.data;
    if (!b) return [] as Deposito[];
    /* i depositi che hanno conducenti o turni nei due giorni */
    const presenti = new Set<string>([
      ...b.drivers.map((d) => d.depositoCodice).filter((x): x is string => !!x),
      ...Object.values(b.dutiesByDss).flat().map((d) => d.depositoCodice).filter((x): x is string => !!x),
    ]);
    return (b.depositi ?? []).filter((d) => presenti.has(d.codice));
  }, [tabellone.data]);
  /* il primo dei miei depositi, se ne ho; altrimenti il primo che c'è */
  useEffect(() => {
    if (deposito || !depositi.length) return;
    const miei = new Set([...(user?.depositi ?? []), ...(user?.depositiVisibili ?? [])].map((x) => x.toLowerCase()));
    setDeposito((depositi.find((d) => miei.has(d.codice.toLowerCase()) || miei.has(d.nome.toLowerCase())) ?? depositi[0]!).codice);
  }, [depositi, deposito, user]);

  const v = useMemo(() => (tabellone.data ? vestizione(tabellone.data, giorno, deposito === "tutti" ? null : deposito) : null), [tabellone.data, giorno, deposito]);
  const nomeDeposito = deposito === "tutti" ? "Tutti i depositi" : depositi.find((d) => d.codice === deposito)?.nome ?? "";
  const daCoprire = v?.turni.filter((t) => t.stato === "scoperto" || t.stato === "liberato").length ?? 0;

  const stampa = () => {
    if (!v) return;
    const w = window.open("", "_blank");
    if (!w) { setMessaggio({ tipo: "errore", testo: "Il browser ha bloccato la finestra di stampa: consentila per questo sito" }); return; }
    w.document.write(ordineDiServizio(v, {
      giorno, deposito: nomeDeposito, azienda: azienda.compilata ? azienda.nome : null,
      stampatoIl: new Date().toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    }));
    w.document.close();
    w.focus();
    w.print();
  };

  const assegna = async (t: TurnoDelGiorno, driverId: string, nome: string) => {
    setMessaggio(null);
    try {
      await apiFetch("/api/roster/assignments", { method: "POST", body: JSON.stringify({ driverId, day: giorno, dssId: t.dssId, dutyCode: t.codice }) });
      setMessaggio({ tipo: "ok", testo: `${t.codice} a ${nome}` });
      setAperto(null);
      await qc.invalidateQueries({ queryKey: ["vestizione"] });
      await qc.invalidateQueries({ queryKey: ["roster"] });
    } catch (e: any) {
      setMessaggio({ tipo: "errore", testo: e?.message ? `${e.message}. Se serve forzare un avviso, assegnalo dal tabellone.` : "Assegnazione non riuscita" });
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start gap-3">
        <UserCheck className="w-6 h-6 text-primary mt-0.5" />
        <div>
          <h1 className="text-xl font-semibold">Vestizione</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            I turni del deposito e chi li fa, oggi e domani. Quelli da coprire stanno in cima, coi sostituti suggeriti: decide chi
            assegna, con gli stessi controlli del <Link href="/roster" className="underline underline-offset-2">tabellone</Link>.
            {!scrive && " Hai il roster in sola lettura."}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="vestizione-deposito">Deposito</Label>
          <select id="vestizione-deposito" className={`${selectCls} block`} value={deposito ?? ""} onChange={(e) => { setDeposito(e.target.value); setAperto(null); }}>
            {depositi.map((d) => <option key={d.codice} value={d.codice}>{d.nome}</option>)}
            <option value="tutti">Tutti i depositi</option>
          </select>
        </div>
        <div className="flex rounded-md border border-input overflow-hidden" role="group" aria-label="Giorno">
          {[[oggi, "Oggi"], [domani, "Domani"]].map(([g, n]) => (
            <button key={g} type="button" aria-pressed={giorno === g} onClick={() => { setGiorno(g!); setAperto(null); }}
              className={`h-9 px-3 text-sm ${giorno === g ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
              {n} <span className="opacity-70">· {new Date(`${g}T12:00:00`).toLocaleDateString("it-IT", { day: "numeric", month: "short" })}</span>
            </button>
          ))}
        </div>
        <Button variant="outline" onClick={() => void tabellone.refetch()} disabled={tabellone.isFetching}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${tabellone.isFetching ? "animate-spin" : ""}`} />Aggiorna
        </Button>
        <Button variant="outline" onClick={stampa} disabled={!v || !v.turni.length}>
          <Printer className="w-4 h-4 mr-1.5" />Stampa l'ordine di servizio
        </Button>
      </div>

      {messaggio && <div role="status" className={`text-sm ${messaggio.tipo === "ok" ? "text-emerald-300" : "text-destructive"}`}>{messaggio.testo}</div>}
      {tabellone.isError && <div className="text-sm text-destructive">Tabellone non leggibile: {(tabellone.error as Error)?.message}</div>}

      {v && (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="w-4 h-4" />Turni · {nomeDeposito} · <span className="first-letter:uppercase">{giornoLungo(giorno)}</span>
              </CardTitle>
              <p className="text-xs text-muted-foreground tabular-nums">
                {v.turni.length} turni pubblicati{daCoprire ? <span className="text-amber-300"> · {daCoprire} da coprire</span> : " · tutti coperti"}
              </p>
            </CardHeader>
            <CardContent>
              {v.turni.length === 0 ? (
                <div className="text-sm text-muted-foreground">Nessun turno pubblicato per questo deposito in questo giorno.</div>
              ) : (
                <div className="overflow-x-auto rounded-md border border-border/50">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted-foreground"><tr className="text-left">
                      <th className="px-3 py-1.5">Turno</th><th className="px-3 py-1.5">Orario</th><th className="px-3 py-1.5">Conducente</th>
                      <th className="px-3 py-1.5">Stato</th><th className="px-3 py-1.5" />
                    </tr></thead>
                    <tbody>
                      {v.turni.map((t) => {
                        const chiave = `${t.dssId}|${t.codice}`;
                        const daFare = t.stato === "scoperto" || t.stato === "liberato";
                        return (
                          <FilaTurno key={chiave} t={t} aperto={aperto === chiave} daFare={daFare} scrive={scrive} giorno={giorno}
                            onApri={() => setAperto(aperto === chiave ? null : chiave)} onAssegna={assegna} />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
          <MezziCard giorno={giorno} deposito={deposito === "tutti" ? null : deposito} />
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Users className="w-4 h-4" />Conducenti</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {GRUPPI.map(([g, titolo]) => (
                <div key={g}>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{titolo} · {v.conducenti[g].length}</div>
                  {v.conducenti[g].length === 0 ? <div className="text-xs text-muted-foreground">—</div> : (
                    <ul className="space-y-0.5">
                      {v.conducenti[g].map((c) => (
                        <li key={c.id} className="flex items-baseline gap-2">
                          <span className="flex-1 min-w-0 truncate">{c.nome}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{[c.voce, ...c.turni].filter(Boolean).join(" · ")}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
          </div>
        </div>
      )}
    </div>
  );
}

/** I mezzi del deposito nel giorno (5.3): quanti ne servono, quanti ce ne sono, chi è fermo in officina. */
function MezziCard({ giorno, deposito }: { giorno: string; deposito: string | null }) {
  const q = useQuery({
    queryKey: ["vestizione", "mezzi", giorno],
    queryFn: () => apiFetch<MezziDelGiorno>(`/api/roster/mezzi?giorno=${giorno}`),
    refetchInterval: 300_000,
    retry: false,
  });
  if (q.isLoading) return null;
  if (q.isError || !q.data) return null;
  const m = mezziDi(q.data, deposito);
  const data = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : "");
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Bus className="w-4 h-4" />Mezzi</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!q.data.giornata ? (
          <div className="text-xs text-muted-foreground">La giornata non è ancora preparata: non si sa quanti mezzi servono.</div>
        ) : !m ? (
          <div className="text-xs text-muted-foreground">Nessun turno macchina né mezzo per questo deposito.</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 tabular-nums">
              <div><div className="text-xl font-semibold">{m.fabbisogno.totale}</div><div className="text-xs text-muted-foreground">servono</div></div>
              <div><div className="text-xl font-semibold">{m.disponibili ? m.disponibili.totale : "—"}</div><div className="text-xs text-muted-foreground">disponibili</div></div>
              <div>
                <div className={`text-xl font-semibold ${m.margine != null && m.margine < 0 ? "text-rose-400" : m.margine != null ? "text-emerald-400" : ""}`}>
                  {m.margine == null ? "—" : m.margine > 0 ? `+${m.margine}` : m.margine}
                </div>
                <div className="text-xs text-muted-foreground">{m.margine != null && m.margine < 0 ? "mancano" : "margine"}</div>
              </div>
            </div>
            {m.fabbisogno.perTipo.length > 0 && (
              <div className="text-xs text-muted-foreground">Per tipo: {m.fabbisogno.perTipo.map((t) => `${t.tipo} ${t.turni}`).join(" · ")}</div>
            )}
            {m.disponibili && <div className="text-xs text-muted-foreground">In servizio {m.disponibili.inServizio}, di riserva {m.disponibili.riserva}</div>}
            {m.perTipo.filter((t) => t.ci_sono < t.servono).map((t) => (
              <div key={t.tipo} className="text-xs text-rose-300">{t.tipo}: ne servono {t.servono}, ce ne sono {t.ci_sono}</div>
            ))}
            {m.inOfficina.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Fermi in officina · {m.inOfficina.length}</div>
                <ul className="text-xs space-y-0.5">
                  {m.inOfficina.slice(0, 8).map((f) => (
                    <li key={f.matricola} className="flex gap-2">
                      <span className="font-mono">{f.matricola}</span>
                      <span className="text-muted-foreground truncate">{[f.modello, f.fermoDal ? `dal ${data(f.fermoDal)}` : null, f.commessa].filter(Boolean).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {!q.data.officina.disponibile ? (
          <div className="text-xs text-amber-300">Officina non collegata: {q.data.officina.motivo ?? "FleetCare non risponde"}. Resta il fabbisogno.</div>
        ) : q.data.officina.statoDiAdesso && (
          <div className="text-xs text-muted-foreground">La disponibilità è quella di adesso in officina: chi è fermo oggi si conta fermo anche domani.</div>
        )}
      </CardContent>
    </Card>
  );
}

function FilaTurno({ t, aperto, daFare, scrive, giorno, onApri, onAssegna }: {
  t: TurnoDelGiorno; aperto: boolean; daFare: boolean; scrive: boolean; giorno: string;
  onApri: () => void; onAssegna: (t: TurnoDelGiorno, driverId: string, nome: string) => Promise<void>;
}) {
  const sostituti = useQuery({
    queryKey: ["vestizione", "sostituti", giorno, t.dssId, t.codice],
    queryFn: () => apiFetch<Sostituti>(`/api/roster/sostituti?day=${giorno}&dssId=${t.dssId}&dutyCode=${encodeURIComponent(t.codice)}`),
    enabled: aperto,
    staleTime: 30_000,
    retry: false,
  });
  const stato = STATO[t.stato];
  return (
    <>
      <tr className={`border-t border-border/40 align-top ${daFare ? "bg-amber-500/5" : ""}`}>
        <td className="px-3 py-1.5 font-mono font-semibold">{t.codice}<div className="text-xs font-sans font-normal text-muted-foreground">{t.tipo ?? ""}</div></td>
        <td className="px-3 py-1.5 tabular-nums whitespace-nowrap">{t.inizio ?? "?"}–{t.fine ?? "?"}</td>
        <td className="px-3 py-1.5">
          {t.conducente ? t.conducente.nome : <span className="text-muted-foreground">—</span>}
          {t.stato === "coperto" && t.titolare && <div className="text-xs text-sky-300">sostituisce {t.titolare.nome}</div>}
          {t.stato === "liberato" && t.titolare && <div className="text-xs text-rose-300">{t.titolare.nome} è assente</div>}
        </td>
        <td className={`px-3 py-1.5 text-xs ${stato.cls}`}>{stato.testo}</td>
        <td className="px-3 py-1.5 text-right">
          {daFare && scrive && (
            <Button size="sm" variant={aperto ? "secondary" : "outline"} className="h-7" onClick={onApri} aria-expanded={aperto}>Sostituti</Button>
          )}
        </td>
      </tr>
      {aperto && (
        <tr className="bg-muted/30">
          <td colSpan={5} className="px-3 py-2">
            {sostituti.isLoading ? <div className="text-xs text-muted-foreground">Cerco i sostituti…</div>
              : sostituti.isError || !sostituti.data ? <div className="text-xs text-destructive">Sostituti non disponibili</div>
              : sostituti.data.sostituti.length === 0 ? (
                <div className="text-xs text-muted-foreground">Nessuno del deposito può coprirlo senza riposi corti o turni sovrapposti.</div>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {sostituti.data.sostituti.slice(0, 20).map((s) => (
                    <li key={s.id} className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1">
                      <span>{s.nome}</span>
                      <span className="text-xs text-muted-foreground">{GRUPPO_SOSTITUTO[s.gruppo]}{s.turni.length ? ` · ${s.turni.join(", ")}` : ""}</span>
                      <Button size="sm" className="h-6 px-2 text-xs" onClick={() => void onAssegna(t, s.id, s.nome)}>Assegna</Button>
                    </li>
                  ))}
                </ul>
              )}
            {sostituti.data && sostituti.data.fuori.assenti + sostituti.data.fuori.violazioni > 0 && (
              <div className="text-xs text-muted-foreground mt-1">
                Esclusi: {sostituti.data.fuori.assenti} assenti o a riposo, {sostituti.data.fuori.violazioni} con riposi corti o turni sovrapposti.
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
