/**
 * La mappa di Argos: la biblioteca vista come rete. Due viste:
 * - documenti: due documenti sono vicini se parlano delle stesse cose
 *   (affinità fra gli embedding, calcolata da Argos senza token);
 * - concetti: il «cervello», i concetti estratti dai passaggi e le relazioni
 *   fra loro (prerequisito, generalizza, applica, contraddice, correlato).
 *
 * Il colore è la categoria (stesso elenco e stesse tinte della biblioteca);
 * la grandezza è il numero di passaggi. Passando sopra a un nodo si accendono
 * i suoi vicini; cliccando si aprono i legami nel pannello. C'è sempre anche
 * la tabella, per chi preferisce leggere.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as PE } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { BookOpen, Brain, FileText, Maximize2, Minus, Network, Plus, Table2, X } from "lucide-react";
import { mappe, type MappaDati } from "@/lib/argos-console";
import {
  disponi, elencoTinte, raggio, RELAZIONI, SENZA_CATEGORIA, tintaCategoria, vicini, type ArcoGrafo, type NodoGrafo,
} from "@/lib/argos-grafo";
import { Caricamento, Pill, Problema, Riquadro, Vuoto } from "./comuni";

const W = 1000, H = 640;
type Vista = "documenti" | "concetti";
type Id = string | number;

function chiave(id: Id): string { return String(id); }

interface Vista2D { k: number; x: number; y: number }
const VISTA_INIZIALE: Vista2D = { k: 1, x: 0, y: 0 };

function useMappa(vista: Vista) {
  return useQuery<MappaDati>({
    queryKey: ["argos-console", "mappa", vista],
    queryFn: () => (vista === "documenti" ? mappe.documenti() : mappe.concetti(160)),
    staleTime: 60_000,
  });
}

// ─── il pannello ────────────────────────────────────────────────────────────
function LegamiDocumento({ id, nodi, scegli }: { id: number; nodi: Map<string, NodoGrafo>; scegli: (id: Id) => void }) {
  const q = useQuery({ queryKey: ["argos-console", "mappa", "documento", id], queryFn: () => mappe.documento(id) });
  if (q.isLoading) return <Caricamento testo="Cerco i passaggi in comune…" />;
  if (q.error) return <Problema errore={q.error} />;
  const links = q.data?.links ?? [];
  if (!links.length) return <Vuoto>Nessun passaggio vicino ad altri documenti.</Vuoto>;
  return (
    <ul className="space-y-1.5">
      {links.slice(0, 14).map((l, i) => (
        <li key={i}>
          <button type="button" onClick={() => scegli(l.dst_document_id)} disabled={!nodi.has(chiave(l.dst_document_id))}
            className="w-full rounded-lg border border-border px-2.5 py-1.5 text-left text-[11px] hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-foreground" title={l.dst_title}>{l.dst_title}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(l.score * 100)}%</span>
            </div>
            <div className="mt-0.5 truncate text-muted-foreground" title={`${l.src_section ?? "—"} → ${l.dst_section ?? "—"}`}>
              {l.src_section ?? "—"} <span aria-hidden>→</span><span className="sr-only">vicino a</span> {l.dst_section ?? "—"}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Pannello({ vista, nodo, nodi, archi, categorie, scegli, chiudi, apriInBiblioteca }: {
  vista: Vista; nodo: NodoGrafo; nodi: Map<string, NodoGrafo>; archi: ArcoGrafo[]; categorie: string[];
  scegli: (id: Id) => void; chiudi: () => void; apriInBiblioteca?: (id: number) => void;
}) {
  const miei = archi
    .filter(a => a.source === nodo.id || a.target === nodo.id)
    .map(a => {
      const altro = a.source === nodo.id ? a.target : a.source;
      const rel = a.rel ? RELAZIONI[a.rel] ?? RELAZIONI.correlato! : null;
      // il verso: «A è prerequisito di B»; se il verso è dall'altro lato si legge al contrario
      const daMe = !rel?.verso || a.from == null || a.from === nodo.id;
      return { altro, peso: a.weight, rel: a.rel ?? null, nome: rel?.nome ?? null, daMe };
    })
    .sort((x, y) => y.peso - x.peso);
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {vista === "documenti" ? <FileText className="h-3.5 w-3.5" aria-hidden /> : <Brain className="h-3.5 w-3.5" aria-hidden />}
            {vista === "documenti" ? "Documento" : "Concetto"}
          </div>
          <h3 className="flex items-center gap-2 text-sm font-semibold leading-tight">
            <span className="argos-cat-punto" data-cat={tintaCategoria(nodo.category, categorie)} aria-hidden />{nodo.title}
          </h3>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{nodo.category ?? SENZA_CATEGORIA} · {nodo.chunks} passaggi · {miei.length} legami</div>
        </div>
        <button type="button" onClick={chiudi} aria-label="Chiudi" className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>

      {vista === "documenti" && typeof nodo.id === "number" && (
        <>
          {apriInBiblioteca && (
            <button type="button" onClick={() => apriInBiblioteca(nodo.id as number)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted">
              <BookOpen className="h-3.5 w-3.5" aria-hidden />Apri in biblioteca
            </button>
          )}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">Passaggi vicini in altri documenti</div>
            <LegamiDocumento id={nodo.id} nodi={nodi} scegli={scegli} />
          </div>
        </>
      )}

      <div>
        <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{vista === "documenti" ? "Documenti affini" : "Relazioni"}</div>
        {miei.length ? (
          <ul className="space-y-1">
            {miei.slice(0, 16).map((m, i) => {
              const n = nodi.get(chiave(m.altro));
              if (!n) return null;
              return (
                <li key={i}>
                  <button type="button" onClick={() => scegli(m.altro)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] hover:bg-muted">
                    <span className="argos-cat-punto" data-cat={tintaCategoria(n.category, categorie)} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">
                      {m.nome ? (m.daMe ? <><span className="text-muted-foreground">{m.nome} </span>{n.title}</> : <>{n.title}<span className="text-muted-foreground"> {m.nome} questo</span></>) : n.title}
                    </span>
                    <span className="h-1 w-12 shrink-0 rounded-full bg-muted" data-tinta="info">
                      <span className="argos-barra block h-full rounded-full" style={{ width: `${Math.round(m.peso * 100)}%` }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <div className="text-[11px] text-muted-foreground">Nessun legame sopra la soglia.</div>}
      </div>
    </div>
  );
}

// ─── la mappa ───────────────────────────────────────────────────────────────
export default function Mappa({ documentoIniziale, apriInBiblioteca }: { documentoIniziale?: number | null; apriInBiblioteca?: (id: number) => void }) {
  const [vista, setVista] = useState<Vista>("documenti");
  const [scelto, setScelto] = useState<Id | null>(documentoIniziale ?? null);
  const [sopra, setSopra] = useState<Id | null>(null);
  const [isolata, setIsolata] = useState<string | null>(null);
  const [tabella, setTabella] = useState(false);
  const [v, setV] = useState<Vista2D>(VISTA_INIZIALE);
  const [punta, setPunta] = useState<{ x: number; y: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const trascina = useRef<{ x: number; y: number; vx: number; vy: number; mosso: boolean } | null>(null);
  const q = useMappa(vista);

  useEffect(() => { if (documentoIniziale) { setVista("documenti"); setScelto(documentoIniziale); } }, [documentoIniziale]);

  const nodi = useMemo(() => q.data?.nodes ?? [], [q.data]);
  const archi = useMemo(() => q.data?.edges ?? [], [q.data]);
  const categorie = useMemo(() => elencoTinte(q.data?.categories ?? [], nodi.map(n => n.category)), [q.data, nodi]);
  const perId = useMemo(() => new Map(nodi.map(n => [chiave(n.id), n])), [nodi]);
  const pos = useMemo(() => disponi(nodi, archi, { larghezza: W, altezza: H }), [nodi, archi]);
  const maxChunk = useMemo(() => Math.max(1, ...nodi.map(n => n.chunks)), [nodi]);
  const grado = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of archi) { m.set(chiave(a.source), (m.get(chiave(a.source)) ?? 0) + 1); m.set(chiave(a.target), (m.get(chiave(a.target)) ?? 0) + 1); }
    return m;
  }, [archi]);
  // le etichette sempre visibili: i nodi più grandi; le altre compaiono al passaggio
  const etichettati = useMemo(() => new Set([...nodi].sort((a, b) => b.chunks - a.chunks).slice(0, vista === "documenti" ? 14 : 18).map(n => chiave(n.id))), [nodi, vista]);
  const fuoco = sopra ?? scelto;
  const accesi = useMemo(() => (fuoco != null ? new Set([...vicini(fuoco, archi)].map(chiave)) : null), [fuoco, archi]);
  const perCategoria = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodi) m.set(n.category ?? "", (m.get(n.category ?? "") ?? 0) + 1);
    return m;
  }, [nodi]);
  const nodoScelto = scelto != null ? perId.get(chiave(scelto)) ?? null : null;

  // la rotella ingrandisce attorno al puntatore (serve un ascoltatore non passivo)
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ruota = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
      setV(o => {
        const k = Math.max(0.5, Math.min(5, o.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        return { k, x: px - ((px - o.x) / o.k) * k, y: py - ((py - o.y) / o.k) * k };
      });
    };
    el.addEventListener("wheel", ruota, { passive: false });
    return () => el.removeEventListener("wheel", ruota);
  }, [tabella, q.data]);

  const zoom = useCallback((f: number) => setV(o => {
    const k = Math.max(0.5, Math.min(5, o.k * f));
    return { k, x: W / 2 - ((W / 2 - o.x) / o.k) * k, y: H / 2 - ((H / 2 - o.y) / o.k) * k };
  }), []);

  const giu = (e: PE<SVGSVGElement>) => {
    if ((e.target as Element).closest("[data-nodo]")) return;
    trascina.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, mosso: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const muovi = (e: PE<SVGSVGElement>) => {
    const r = svg.current?.getBoundingClientRect();
    if (r) setPunta({ x: e.clientX - r.left, y: e.clientY - r.top });
    const t = trascina.current;
    if (!t || !r) return;
    const dx = ((e.clientX - t.x) / r.width) * W, dy = ((e.clientY - t.y) / r.height) * H;
    if (Math.abs(dx) + Math.abs(dy) > 2) t.mosso = true;
    setV(o => ({ ...o, x: t.vx + dx, y: t.vy + dy }));
  };
  const su = () => {
    const t = trascina.current;
    trascina.current = null;
    if (t && !t.mosso) setScelto(null); // un clic sul fondo chiude
  };

  const cambiaVista = (nv: Vista) => { setVista(nv); setScelto(null); setSopra(null); setIsolata(null); setV(VISTA_INIZIALE); };
  const nodoSopra = sopra != null ? perId.get(chiave(sopra)) : null;

  const visibile = (n: NodoGrafo) => isolata === null || (n.category ?? "") === isolata;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Riquadro
        titolo={<span className="inline-flex items-center gap-1.5"><Network className="h-4 w-4" aria-hidden />La mappa della conoscenza</span>}
        azione={
          <div className="flex items-center gap-1.5">
            <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Che cosa mostrare">
              {(["documenti", "concetti"] as const).map(x => (
                <button key={x} type="button" onClick={() => cambiaVista(x)} aria-pressed={vista === x}
                  className={`rounded px-2.5 py-1 text-xs font-medium ${vista === x ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                  {x === "documenti" ? "Documenti" : "Concetti"}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setTabella(t => !t)} aria-pressed={tabella}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${tabella ? "border-primary bg-primary/10" : "border-border hover:bg-muted"}`}>
              <Table2 className="h-3.5 w-3.5" aria-hidden />Tabella
            </button>
          </div>
        }>
        {q.isLoading ? <Caricamento testo="Disegno la mappa…" /> : q.error ? <Problema errore={q.error} /> : !nodi.length ? (
          <Vuoto>{vista === "documenti" ? "Nessun documento in biblioteca." : "Nessun concetto ancora: estraili dalla scheda Biblioteca."}</Vuoto>
        ) : tabella ? (
          <div className="max-h-[40rem] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-card text-[11px] text-muted-foreground">
                <tr><th className="py-1.5 font-medium">{vista === "documenti" ? "Documento" : "Concetto"}</th><th className="py-1.5 font-medium">Categoria</th>
                  <th className="py-1.5 text-right font-medium">Passaggi</th><th className="py-1.5 text-right font-medium">Legami</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[...nodi].sort((a, b) => b.chunks - a.chunks).map(n => (
                  <tr key={chiave(n.id)} className="cursor-pointer hover:bg-muted/60" onClick={() => setScelto(n.id)}>
                    <td className="py-1.5 pr-2"><span className="inline-flex items-center gap-2"><span className="argos-cat-punto" data-cat={tintaCategoria(n.category, categorie)} aria-hidden />{n.title}</span></td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{n.category ?? SENZA_CATEGORIA}</td>
                    <td className="py-1.5 text-right tabular-nums">{n.chunks}</td>
                    <td className="py-1.5 text-right tabular-nums">{grado.get(chiave(n.id)) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="relative">
            {q.data?.warning && <div className="mb-2"><Pill tinta="avviso">{q.data.warning}</Pill></div>}
            <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="argos-palco h-[min(68vh,640px)] w-full touch-none select-none rounded-lg"
              role="img" aria-label={`Mappa dei ${vista}: ${nodi.length} nodi e ${archi.length} legami. La tabella ha gli stessi dati.`}
              onPointerDown={giu} onPointerMove={muovi} onPointerUp={su} onPointerLeave={() => { setPunta(null); setSopra(null); }}
              style={{ cursor: trascina.current ? "grabbing" : "grab" }}>
              <defs>
                <marker id="argos-freccia" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" style={{ fill: "hsl(var(--muted-foreground))" }} />
                </marker>
              </defs>
              <g transform={`translate(${v.x} ${v.y}) scale(${v.k})`}>
                {archi.map((a, i) => {
                  const p1 = pos.get(a.source), p2 = pos.get(a.target);
                  const n1 = perId.get(chiave(a.source)), n2 = perId.get(chiave(a.target));
                  if (!p1 || !p2 || !n1 || !n2) return null;
                  const tocca = accesi && fuoco != null && (chiave(a.source) === chiave(fuoco) || chiave(a.target) === chiave(fuoco));
                  const spento = (accesi && !tocca) || !visibile(n1) || !visibile(n2);
                  const rel = a.rel ? RELAZIONI[a.rel] : undefined;
                  const versoInverso = rel?.verso && a.from != null && chiave(a.from) === chiave(a.target);
                  const [da, a2] = versoInverso ? [p2, p1] : [p1, p2];
                  const nd = versoInverso ? n1 : n2;
                  // la freccia si ferma sul bordo del nodo d'arrivo
                  const dx = a2.x - da.x, dy = a2.y - da.y, d = Math.hypot(dx, dy) || 1;
                  const rArr = raggio(nd.chunks, maxChunk) + 3;
                  return (
                    <line key={i} x1={da.x} y1={da.y} x2={a2.x - (dx / d) * (rel?.verso ? rArr : 0)} y2={a2.y - (dy / d) * (rel?.verso ? rArr : 0)}
                      data-cat={tocca ? tintaCategoria(perId.get(chiave(fuoco!))?.category, categorie) : undefined}
                      className={tocca ? "argos-cat-tratto" : undefined}
                      style={{
                        stroke: tocca ? undefined : "hsl(var(--foreground))",
                        strokeOpacity: spento ? 0.04 : tocca ? 0.9 : 0.1 + a.weight * 0.25,
                        strokeWidth: (tocca ? 2 : 0.6 + a.weight * 1.6) / v.k,
                        strokeDasharray: a.rel === "contraddice" ? `${5 / v.k} ${4 / v.k}` : undefined,
                        transition: "stroke-opacity 160ms",
                      }}
                      markerEnd={rel?.verso && (tocca || !accesi) ? "url(#argos-freccia)" : undefined} />
                  );
                })}
                {nodi.map((n, i) => {
                  const p = pos.get(n.id);
                  if (!p) return null;
                  const r = raggio(n.chunks, maxChunk);
                  const k = chiave(n.id);
                  const acceso = !accesi || accesi.has(k);
                  const on = visibile(n) && acceso;
                  const etichetta = (etichettati.has(k) && !accesi && visibile(n)) || (accesi?.has(k) ?? false) || chiave(scelto ?? "") === k;
                  const nome = n.title.length > 34 ? `${n.title.slice(0, 32)}…` : n.title;
                  return (
                    <g key={k} transform={`translate(${p.x} ${p.y})`} data-nodo tabIndex={0} role="button"
                      aria-label={`${n.title}, ${n.category ?? SENZA_CATEGORIA}, ${n.chunks} passaggi`} aria-pressed={chiave(scelto ?? "") === k}
                      onPointerEnter={() => setSopra(n.id)} onPointerLeave={() => setSopra(s => (s === n.id ? null : s))}
                      onFocus={() => setSopra(n.id)} onBlur={() => setSopra(null)}
                      onClick={() => setScelto(s => (s === n.id ? null : n.id))}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setScelto(n.id); } }}
                      style={{ cursor: "pointer", outline: "none" }}>
                      <motion.g initial={{ opacity: 0, scale: 0.2 }} animate={{ opacity: on ? 1 : 0.14, scale: 1 }}
                        transition={{ duration: 0.45, delay: Math.min(i * 0.006, 0.9), ease: "easeOut" }}>
                        <circle r={Math.max(r, 11) / Math.sqrt(v.k)} fill="transparent" />
                        {chiave(scelto ?? "") === k && <circle r={(r + 5) / Math.sqrt(v.k)} fill="none" style={{ stroke: "hsl(var(--foreground))", strokeWidth: 1.5 / v.k }} />}
                        <circle r={r / Math.sqrt(v.k)} data-cat={tintaCategoria(n.category, categorie)} className="argos-cat-riempi"
                          style={{ stroke: "hsl(var(--card))", strokeWidth: 2 / v.k }} />
                        {etichetta && (
                          <text y={(r / Math.sqrt(v.k)) + 12 / v.k} textAnchor="middle"
                            style={{ fontSize: 11 / v.k, fontWeight: 600, fill: "hsl(var(--foreground))", paintOrder: "stroke", stroke: "hsl(var(--card))", strokeWidth: 3 / v.k, strokeLinejoin: "round", pointerEvents: "none" }}>
                            {nome}
                          </text>
                        )}
                      </motion.g>
                    </g>
                  );
                })}
              </g>
            </svg>
            {nodoSopra && punta && (
              <div className="pointer-events-none absolute z-10 max-w-[16rem] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-md"
                style={{ left: Math.min(punta.x + 14, (svg.current?.clientWidth ?? 600) - 260), top: punta.y + 12 }}>
                <div className="flex items-center gap-1.5 font-semibold"><span className="argos-cat-punto" data-cat={tintaCategoria(nodoSopra.category, categorie)} aria-hidden />{nodoSopra.title}</div>
                <div className="text-muted-foreground">{nodoSopra.category ?? SENZA_CATEGORIA} · {nodoSopra.chunks} passaggi · {grado.get(chiave(nodoSopra.id)) ?? 0} legami</div>
              </div>
            )}
            <div className="absolute bottom-2 right-2 flex flex-col gap-1">
              <button type="button" onClick={() => zoom(1.3)} aria-label="Ingrandisci" className="rounded-md border border-border bg-card p-1.5 shadow-sm hover:bg-muted"><Plus className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => zoom(1 / 1.3)} aria-label="Rimpicciolisci" className="rounded-md border border-border bg-card p-1.5 shadow-sm hover:bg-muted"><Minus className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setV(VISTA_INIZIALE)} aria-label="Rimetti a posto" className="rounded-md border border-border bg-card p-1.5 shadow-sm hover:bg-muted"><Maximize2 className="h-3.5 w-3.5" /></button>
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground">
              {nodi.length} {vista} · {archi.length} legami · trascina per spostarti, rotella per ingrandire, clic su un nodo per i legami
            </div>
          </div>
        )}
      </Riquadro>

      <div className="space-y-4">
        {nodoScelto ? (
          <Riquadro>
            <Pannello key={chiave(nodoScelto.id)} vista={vista} nodo={nodoScelto} nodi={perId} archi={archi} categorie={categorie}
              scegli={setScelto} chiudi={() => setScelto(null)} apriInBiblioteca={apriInBiblioteca} />
          </Riquadro>
        ) : (
          <Riquadro titolo="Come si legge">
            <p className="text-xs text-muted-foreground">
              {vista === "documenti"
                ? "Ogni cerchio è un documento, grande quanto i suoi passaggi. Due documenti sono collegati se parlano delle stesse cose: Argos lo misura confrontando il significato dei testi, non le parole."
                : "Ogni cerchio è un concetto estratto dai passaggi, grande quanto i passaggi che lo citano. Le linee sono le relazioni che Argos ha riconosciuto; la freccia indica il verso."}
            </p>
            {vista === "concetti" && (
              <ul className="mt-3 space-y-1 text-[11px]">
                {Object.entries(RELAZIONI).map(([k, r]) => (
                  <li key={k} className="flex items-center gap-2">
                    <svg width="34" height="8" aria-hidden>
                      <line x1="1" y1="4" x2={r.verso ? 27 : 33} y2="4" style={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1.5, strokeDasharray: k === "contraddice" ? "4 3" : undefined }} />
                      {r.verso && <path d="M27,0.5 L34,4 L27,7.5 z" style={{ fill: "hsl(var(--muted-foreground))" }} />}
                    </svg>
                    <span><b>{k}</b> <span className="text-muted-foreground">— A {r.nome} B</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Riquadro>
        )}

        <Riquadro titolo="Categorie" azione={isolata !== null ? <button type="button" onClick={() => setIsolata(null)} className="text-[11px] text-muted-foreground hover:text-foreground">Mostra tutte</button> : undefined}>
          <ul className="space-y-0.5" aria-label="Clic su una categoria per isolarla">
            {[...categorie.filter(c => perCategoria.has(c)), ...(perCategoria.has("") ? [""] : [])].map(c => (
              <li key={c || "-"}>
                <button type="button" onClick={() => setIsolata(s => (s === c ? null : c))} aria-pressed={isolata === c}
                  className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs ${isolata === c ? "bg-muted" : "hover:bg-muted/60"} ${isolata !== null && isolata !== c ? "opacity-50" : ""}`}>
                  <span className="argos-cat-punto" data-cat={tintaCategoria(c || null, categorie)} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c || SENZA_CATEGORIA}</span>
                  <span className="tabular-nums text-muted-foreground">{perCategoria.get(c) ?? 0}</span>
                </button>
              </li>
            ))}
          </ul>
        </Riquadro>
      </div>
    </div>
  );
}
