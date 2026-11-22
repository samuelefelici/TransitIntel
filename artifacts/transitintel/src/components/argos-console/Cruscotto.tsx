/**
 * Il cruscotto di Argos: se il collegamento funziona, che cosa sa fare la
 * squadra, quanto ha consumato nel mese, che cosa ha fatto di recente.
 */
import { useQuery } from "@tanstack/react-query";
import { Bot, CheckCircle2, Cpu, Library, Wrench, XCircle } from "lucide-react";
import { console_, nomeModulo, quandoFa, token, type RigaEsecuzione, type StatoArgos } from "@/lib/argos-console";
import { BarraEffetti, Barre, Caricamento, Numero, PillStato, Problema, Riquadro, Vuoto } from "./comuni";

function Collegamento({ stato }: { stato: StatoArgos | undefined }) {
  const voci: Array<{ nome: string; ok: boolean; spiega: string }> = stato ? [
    { nome: "Argos configurato", ok: stato.configured, spiega: stato.configured ? "ARGOS_URL impostata" : (stato.reason ?? "manca ARGOS_URL") },
    { nome: "Argos raggiungibile", ok: !!stato.reachable, spiega: stato.reachable ? "risponde" : (stato.error ?? "non risponde") },
    { nome: "Segreto del proxy", ok: !!stato.proxySecret && !!stato.argosProxy, spiega: stato.proxySecret && stato.argosProxy ? "impostato su Cerbero e su Argos" : "ARGOS_PROXY_SECRET manca da una delle due parti" },
    { nome: "Planning Studio", ok: !!stato.transitintel, spiega: stato.transitintel ? "gli agenti leggono i progetti" : "manca TRANSITINTEL_API_URL su Argos" },
    { nome: "Dati di esercizio", ok: !!stato.cerbero, spiega: stato.cerbero ? "il DB di Cerbero in sola lettura" : "manca CERBERO_DATABASE_URL su Argos" },
  ] : [];
  return (
    <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      {voci.map(v => (
        <li key={v.nome} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2" data-tinta={v.ok ? "ok" : "errore"}>
          {v.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 argos-tinta" aria-hidden /> : <XCircle className="mt-0.5 h-4 w-4 argos-tinta" aria-hidden />}
          <div className="min-w-0">
            <div className="text-xs font-semibold">{v.nome} <span className="sr-only">{v.ok ? "a posto" : "da sistemare"}</span></div>
            <div className="truncate text-[11px] text-muted-foreground" title={v.spiega}>{v.spiega}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function Cruscotto({ apriEsecuzione }: { apriEsecuzione: (id: number) => void }) {
  const stato = useQuery({ queryKey: ["argos-console", "stato"], queryFn: console_.stato, refetchInterval: 30_000 });
  const budget = useQuery({ queryKey: ["argos-console", "budget"], queryFn: console_.budget, refetchInterval: 60_000 });
  const registro = useQuery({ queryKey: ["argos-console", "registro"], queryFn: console_.registro });
  const agenti = useQuery({ queryKey: ["argos-console", "agenti"], queryFn: console_.agenti });
  const skill = useQuery({ queryKey: ["argos-console", "skill"], queryFn: console_.skill });
  const esec = useQuery({ queryKey: ["argos-console", "esecuzioni", ""], queryFn: () => console_.esecuzioni(undefined, 50), refetchInterval: 15_000 });

  const righe: RigaEsecuzione[] = esec.data?.esecuzioni ?? [];
  const ok = righe.filter(r => r.status === "completed").length;
  const ko = righe.filter(r => r.status === "failed").length;
  const inCorso = righe.filter(r => r.status === "running").length;
  const tokenRecenti = righe.reduce((s, r) => s + (r.tokens || 0), 0);
  const scritture = (registro.data?.perEffetto.scrittura ?? 0) + (registro.data?.perEffetto.distruttivo ?? 0);
  const quota = budget.data && budget.data.limit ? Math.min(1, budget.data.used / budget.data.limit) : 0;
  const perAgente = Object.entries(righe.reduce<Record<string, number>>((m, r) => ({ ...m, [r.agent_key]: (m[r.agent_key] ?? 0) + 1 }), {}))
    .map(([etichetta, valore]) => ({ etichetta, valore })).sort((a, b) => b.valore - a.valore);

  return (
    <div className="space-y-4">
      <Riquadro titolo="Collegamento">
        {stato.isLoading ? <Caricamento /> : stato.error ? <Problema errore={stato.error} /> : <Collegamento stato={stato.data} />}
      </Riquadro>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Numero etichetta="Agenti" valore={agenti.data?.totale ?? "—"} nota="nella squadra" />
        <Numero etichetta="Skill" valore={skill.data?.totale ?? "—"} nota="in biblioteca" />
        <Numero etichetta="Capacità" valore={registro.data?.totale ?? "—"} nota={registro.data ? `${scritture} cambiano i dati di Cerbero` : undefined} />
        <Numero etichetta="Ultime esecuzioni" valore={righe.length} tinta={ko ? "avviso" : undefined}
          nota={`${ok} completate · ${ko} fallite${inCorso ? ` · ${inCorso} in corso` : ""}`} />
        <Numero etichetta="Consumo del mese" tinta={quota > 0.9 ? "errore" : quota > 0.7 ? "avviso" : undefined}
          valore={budget.data ? `${Math.round(quota * 100)}%` : "—"}
          nota={budget.data ? `${token(budget.data.used)} di ${token(budget.data.limit)} token` : budget.error ? "non disponibile" : undefined} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Riquadro titolo={<span className="inline-flex items-center gap-1.5"><Wrench className="h-4 w-4" aria-hidden />Che cosa possono toccare</span>}>
          {registro.isLoading ? <Caricamento /> : registro.error ? <Problema errore={registro.error} /> : registro.data && (
            <div className="space-y-4">
              <BarraEffetti perEffetto={registro.data.perEffetto} />
              <Barre tinta="info" righe={Object.entries(registro.data.perModulo).map(([m, n]) => ({ etichetta: nomeModulo(m), valore: n })).sort((a, b) => b.valore - a.valore)} />
            </div>
          )}
        </Riquadro>

        <Riquadro titolo={<span className="inline-flex items-center gap-1.5"><Bot className="h-4 w-4" aria-hidden />Chi ha lavorato</span>}>
          {esec.isLoading ? <Caricamento /> : perAgente.length ? (
            <div className="space-y-3">
              <Barre tinta="memoria" righe={perAgente} />
              <div className="text-[11px] text-muted-foreground">{token(tokenRecenti)} token nelle ultime {righe.length} esecuzioni</div>
            </div>
          ) : <Vuoto>Nessuna esecuzione ancora: prova dalla scheda «Lavora».</Vuoto>}
        </Riquadro>

        <Riquadro titolo={<span className="inline-flex items-center gap-1.5"><Library className="h-4 w-4" aria-hidden />La squadra</span>}>
          {agenti.isLoading ? <Caricamento /> : agenti.error ? <Problema errore={agenti.error} /> : (
            <ul className="space-y-3">
              {(agenti.data?.agenti ?? []).map(a => (
                <li key={a.chiave}>
                  <div className="flex items-center justify-between gap-2 text-sm"><span className="font-medium">{a.nome}</span>
                    <span className="text-[11px] text-muted-foreground">{a.skills.length} skill · {a.strumenti.length} strumenti</span></div>
                  <div className="mt-1"><BarraEffetti perEffetto={a.perEffetto} legenda={false} /></div>
                </li>
              ))}
            </ul>
          )}
        </Riquadro>
      </div>

      <Riquadro titolo={<span className="inline-flex items-center gap-1.5"><Cpu className="h-4 w-4" aria-hidden />Esecuzioni recenti</span>}>
        {esec.isLoading ? <Caricamento /> : esec.error ? <Problema errore={esec.error} /> : righe.length ? (
          <ul className="divide-y divide-border">
            {righe.slice(0, 8).map(r => (
              <li key={r.id}>
                <button type="button" onClick={() => apriEsecuzione(r.id)}
                  className="grid w-full grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-3 px-1 py-2 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
                  <PillStato stato={r.status} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{r.objective}</span>
                    <span className="block text-[11px] text-muted-foreground">{r.agent_key} · {r.eventi} passi · {r.proposte} proposte{r.project_id ? " · su un progetto" : ""}</span>
                  </span>
                  <span className="text-right text-[11px] text-muted-foreground tabular-nums">{quandoFa(r.created_at)}<br />{token(r.tokens)} token</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <Vuoto>Nessuna esecuzione ancora.</Vuoto>}
      </Riquadro>
    </div>
  );
}
