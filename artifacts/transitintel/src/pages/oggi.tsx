/**
 * Oggi: la pagina d'ingresso. Raccoglie quello che c'è già sul servizio del
 * giorno, ognuno secondo i suoi permessi: il servizio adesso (AVM), i turni
 * di oggi nel roster, il programma in esercizio, l'ultima pubblicazione dei
 * turni; poi le sezioni del menu. Un riquadro che non si può leggere (permesso,
 * AVM spento, errore) semplicemente non c'è. Nessuna API nuova: variazioni del
 * giorno, disponibilità dei mezzi e consuntivo arrivano con la Fase 4.
 */
import type { ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, MapPinned, Users, Map, Send, ArrowRight } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth, type Permission } from "@/hooks/use-auth";
import { sezioniVisibili, CASA } from "@/lib/navigazione";
import { oggiARoma, riassuntoTurni, type ServizioLive, type TabelloneGiorno } from "@/lib/oggi";

interface ProgrammaPs { id: string; name: string; isOperational?: boolean }
interface Pubblicazione { tipo: string; programma: string | null; dal: string; al: string; creataIl: string; autore: string | null }

const data = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString("it-IT", { day: "numeric", month: "short" });

function Riquadro({ titolo, icona: Icona, href, link, children }: {
  titolo: string; icona: typeof Map; href?: string; link?: string; children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/50 bg-card/60 p-4 flex flex-col gap-3" aria-label={titolo}>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <Icona className="w-4 h-4 text-primary" aria-hidden /> {titolo}
      </h2>
      <div className="flex-1">{children}</div>
      {href && link && (
        <Link href={href} className="text-xs text-primary hover:underline inline-flex items-center gap-1 self-start">
          {link} <ArrowRight className="w-3 h-3" aria-hidden />
        </Link>
      )}
    </section>
  );
}

function Numero({ valore, etichetta, tono }: { valore: ReactNode; etichetta: string; tono?: "ok" | "attenzione" }) {
  return (
    <div>
      <div className={`text-2xl font-bold tabular-nums ${tono === "attenzione" ? "text-amber-400" : tono === "ok" ? "text-emerald-400" : ""}`}>{valore}</div>
      <div className="text-[11px] text-muted-foreground">{etichetta}</div>
    </div>
  );
}

export default function OggiPage() {
  const { user, isAdmin, hasPermission } = useAuth();
  const ha = (...p: Permission[]) => isAdmin || p.some(x => hasPermission(x));
  const giorno = oggiARoma();
  /* un riquadro che non si legge sparisce: niente nuovi tentativi né messaggi d'errore */
  const opzioni = { retry: false, staleTime: 60_000 } as const;

  const live = useQuery({
    queryKey: ["oggi", "live"],
    queryFn: () => apiFetch<ServizioLive>("/api/operations/live"),
    enabled: ha("centrale", "analytics"),
    refetchInterval: 60_000,
    ...opzioni,
  });
  const tabellone = useQuery({
    queryKey: ["oggi", "roster", giorno],
    queryFn: () => apiFetch<TabelloneGiorno>(`/api/roster/board?from=${giorno}&days=1`),
    enabled: ha("roster"),
    ...opzioni,
  });
  const programmi = useQuery({
    queryKey: ["oggi", "programmi"],
    queryFn: () => apiFetch<{ projects: ProgrammaPs[] }>("/api/planning-studio/projects").then(r => r.projects ?? []),
    enabled: ha("network", "scheduling"),
    ...opzioni,
  });
  const pubblicazioni = useQuery({
    queryKey: ["oggi", "pubblicazioni"],
    queryFn: () => apiFetch<{ pubblicazioni: Pubblicazione[] }>("/api/roster/pubblicazioni").then(r => r.pubblicazioni ?? []),
    enabled: ha("scheduling"),
    ...opzioni,
  });

  const kpi = live.data?.caronteAvailable === false ? null : live.data?.kpis ?? null;
  const turni = tabellone.data ? riassuntoTurni(tabellone.data, giorno) : null;
  const inEsercizio = programmi.data?.find(p => p.isOperational) ?? null;
  const ultima = pubblicazioni.data?.[0] ?? null;
  const sezioni = sezioniVisibili(hasPermission, isAdmin).filter(s => s.titolo !== "Oggi");
  const titoloGiorno = new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Rome" });

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <CalendarDays className="w-6 h-6 text-primary" aria-hidden /> Oggi
        </h1>
        <p className="text-sm text-muted-foreground first-letter:uppercase">
          {titoloGiorno}{user?.fullName ? ` · ${user.fullName}` : ""}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {live.isSuccess && (
          <Riquadro titolo="Servizio adesso" icona={MapPinned}
            href={ha("centrale") ? "/operations" : undefined} link="Apri la mappa live">
            {kpi ? (
              <div className="grid grid-cols-2 gap-3">
                <Numero valore={kpi.vehiclesActive} etichetta="mezzi in linea" />
                <Numero valore={kpi.tripsActive} etichetta="corse in corso" />
                <Numero valore={kpi.onTimePct != null ? `${Math.round(kpi.onTimePct)}%` : "—"} etichetta="in orario oggi"
                  tono={kpi.onTimePct == null ? undefined : kpi.onTimePct >= 80 ? "ok" : "attenzione"} />
                <Numero valore={kpi.avgDelaySeconds != null ? `${Math.round(kpi.avgDelaySeconds / 60)}′` : "—"} etichetta="ritardo medio" />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">L'AVM non è collegato: i dati del servizio adesso non arrivano.</p>
            )}
          </Riquadro>
        )}

        {turni && (
          <Riquadro titolo="Turni di oggi" icona={Users} href="/roster" link="Apri il roster">
            {turni.pubblicati === 0 ? (
              <p className="text-sm text-muted-foreground">Per oggi non sono stati pubblicati turni guida.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Numero valore={turni.pubblicati} etichetta={`turni pubblicati (${turni.unita} unità)`} />
                <Numero valore={turni.scoperti} etichetta="turni scoperti" tono={turni.scoperti > 0 ? "attenzione" : "ok"} />
                <Numero valore={turni.assenze} etichetta="assenze" />
                <Numero valore={turni.violazioni} etichetta="avvisi su riposi e sovrapposizioni" tono={turni.violazioni > 0 ? "attenzione" : undefined} />
              </div>
            )}
          </Riquadro>
        )}

        {programmi.isSuccess && (
          <Riquadro titolo="Programma in esercizio" icona={Map}
            href={inEsercizio ? (ha("network") ? `/planning-studio/${inEsercizio.id}` : `/fucina/esercizio/${inEsercizio.id}`) : undefined}
            link={ha("network") ? "Apri in Planning Studio" : "Apri il quadro d'esercizio"}>
            {inEsercizio ? (
              <>
                <p className="text-base font-semibold">{inEsercizio.name}</p>
                {ha("scheduling") && ha("network") && (
                  <Link href={`/fucina/esercizio/${inEsercizio.id}`} className="text-xs text-primary hover:underline mt-1 inline-block">
                    Quadro d'esercizio
                  </Link>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nessun programma è in esercizio.</p>
            )}
          </Riquadro>
        )}

        {pubblicazioni.isSuccess && (
          <Riquadro titolo="Turni al roster" icona={Send} href="/roster/pubblicazione" link="Apri la pubblicazione">
            {ultima ? (
              <>
                <p className="text-sm">
                  Ultima pubblicazione: <span className="font-semibold">{data(ultima.dal)} – {data(ultima.al)}</span>
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {ultima.programma ? `${ultima.programma} · ` : ""}{new Date(ultima.creataIl).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {ultima.autore ? ` · ${ultima.autore}` : ""}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Non è ancora stato pubblicato nessun periodo.</p>
            )}
          </Riquadro>
        )}
      </div>

      <section aria-label="Le tue sezioni" className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Le tue sezioni</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sezioni.map(s => (
            <div key={s.titolo} className="rounded-xl border border-border/40 bg-card/40 p-3">
              <p className="text-sm font-semibold mb-2">{s.titolo}</p>
              <ul className="space-y-1">
                {s.voci.filter(v => !v.azione && v.href !== CASA).map(v => (
                  <li key={v.href}>
                    <Link href={v.href} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-2">
                      <v.icona className="w-3.5 h-3.5" aria-hidden /> {v.etichetta}
                    </Link>
                  </li>
                ))}
                {s.voci.some(v => v.azione === "fleetcare") && (
                  <li className="text-xs text-muted-foreground">FleetCare si apre dal menu.</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
