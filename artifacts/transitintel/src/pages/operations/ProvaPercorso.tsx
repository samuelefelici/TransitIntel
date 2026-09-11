/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA PROVA DEL FUORI PERCORSO — dove è passato, dove sarebbe dovuto passare
 * ───────────────────────────────────────────────────────────────────────────
 * Il registro scrive "fuori percorso, fino a 840 m dal tracciato". È
 * un'affermazione sul lavoro di una persona, e finora chi la leggeva non aveva
 * modo di controllarla: un cantiere, una deviazione decisa in centrale e un
 * salto del GPS si somigliano tutti, quando sono un numero.
 *
 * Qui ci sono le due linee da sovrapporre. Si decide guardando, non leggendo.
 *
 * ── Quello che la linea grigia è, e quello che NON è ──
 *
 * Se il feed ha il percorso della corsa, la linea grigia è la strada. Se non
 * ce l'ha, unisce le fermate in retta e TAGLIA LE CURVE: su un'extraurbana
 * quella corda può passare a mezzo chilometro dalla strada vera, e un mezzo
 * perfettamente in linea sembrerebbe deviare. È esattamente l'errore che
 * questa pagina serve a non far commettere, quindi la distinzione sta in
 * testa e non in una nota a piè di pagina.
 *
 * Senza token Mapbox resta uno schema senza strade: dice la FORMA dello
 * scostamento, non su quale via sia avvenuto. Meno utile, non inutile — ed è
 * meglio di un rettangolo che dice "mappa non disponibile" proprio quando
 * qualcuno sta decidendo se contestare qualcosa a un conducente.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Map as MapGL, Source, Layer } from "react-map-gl/mapbox";
import { Loader2, MapPin, Route, TriangleAlert } from "lucide-react";
import { apiFetch } from "@/lib/api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

interface Punto { lat: number; lon: number }
interface PuntoTraccia extends Punto { ts: string; speed: number | null; distanzaM: number | null }
interface FermataMappa {
  seq: number; stopId: string; stopName: string | null;
  lat: number | null; lon: number | null; scheduled: string | null; osservata: boolean;
}

interface Risposta {
  caronteAvailable: boolean;
  tripId?: string;
  day?: string | null;
  giorniDisponibili?: Array<{ day: string; punti: number }>;
  linea?: string | null;
  capolinea?: string | null;
  riferimento?: { tipo: "tracciato" | "fermate"; sogliaM: number; allargata: boolean; nota: string };
  percorso?: Punto[] | null;
  fermate?: FermataMappa[];
  traccia?: PuntoTraccia[];
  fuoriPercorso?: { punti: number; distanzaMassimaM: number };
}

const COLORE_TEORICO = "#64748b";
const COLORE_REALE = "#38bdf8";
const COLORE_FUORI = "#f87171";

export default function ProvaPercorso(
  { tripId, giorno }: { tripId: string; giorno?: string },
) {
  /* La giornata dell'anomalia, non l'ultima disponibile: aprire la prova su
     un altro giorno mostrerebbe una corsa regolare e farebbe archiviare un
     caso vero. */
  const [day, setDay] = useState(giorno ?? "");

  const qs = new URLSearchParams();
  if (day) qs.set("date", day);

  const q = useQuery({
    queryKey: ["prova-percorso", tripId, day],
    queryFn: () => apiFetch<Risposta>(
      `/api/operations/trips/${encodeURIComponent(tripId)}/percorso?${qs.toString()}`),
  });

  const d = q.data;
  const traccia = d?.traccia ?? [];
  const soglia = d?.riferimento?.sogliaM ?? 300;

  /* La traccia si spezza in tratti dentro e fuori soglia, così il rosso cade
   * esattamente dove la misura dice, e non su tutta la corsa. */
  const tratti = useMemo(() => {
    const out: Array<{ fuori: boolean; punti: Punto[] }> = [];
    for (const p of traccia) {
      const fuori = p.distanzaM != null && p.distanzaM > soglia;
      const ultimo = out[out.length - 1];
      if (ultimo && ultimo.fuori === fuori) ultimo.punti.push(p);
      /* Il primo punto del tratto nuovo è anche l'ultimo del precedente:
       * senza, fra i due resta un buco e la linea appare interrotta. */
      else out.push({ fuori, punti: ultimo ? [ultimo.punti[ultimo.punti.length - 1], p] : [p] });
    }
    return out.filter(t => t.punti.length >= 2);
  }, [traccia, soglia]);

  const teorico: Punto[] = useMemo(() => {
    if (d?.percorso && d.percorso.length >= 2) return d.percorso;
    return (d?.fermate ?? [])
      .filter(f => f.lat != null && f.lon != null)
      .map(f => ({ lat: f.lat!, lon: f.lon! }));
  }, [d]);

  const bbox = useMemo(() => {
    const tutti = [...teorico, ...traccia];
    if (tutti.length === 0) return null;
    return {
      minLat: Math.min(...tutti.map(p => p.lat)), maxLat: Math.max(...tutti.map(p => p.lat)),
      minLon: Math.min(...tutti.map(p => p.lon)), maxLon: Math.max(...tutti.map(p => p.lon)),
    };
  }, [teorico, traccia]);

  if (q.isLoading) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Carico la traccia della corsa…
      </div>
    );
  }
  if (!d || !d.caronteAvailable) {
    return <div className="py-8 text-center text-xs text-muted-foreground">Dati di esercizio non disponibili.</div>;
  }
  if (traccia.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
        Nessuna posizione GPS registrata per questa corsa: senza traccia non c'è
        niente da confrontare con il percorso.
      </div>
    );
  }

  const fuoriTot = d.fuoriPercorso?.punti ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {(d.giorniDisponibili?.length ?? 0) > 0 && (
          <>
            <span className="text-muted-foreground">Giornata:</span>
            <select
              value={day || (d.day ?? "")}
              onChange={e => setDay(e.target.value)}
              className="px-2 py-1 rounded bg-card border border-border/60 text-[11px] font-mono">
              {d.giorniDisponibili!.map(g => (
                <option key={g.day} value={g.day}>
                  {new Date(g.day).toLocaleDateString("it-IT")} · {g.punti} punti
                </option>
              ))}
            </select>
          </>
        )}
        <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/5 border border-border/50">
          <Route className="w-3 h-3" style={{ color: COLORE_REALE }} />
          {traccia.length} posizioni
        </span>
        {fuoriTot > 0 ? (
          <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg border"
            style={{ color: COLORE_FUORI, borderColor: COLORE_FUORI + "55", background: COLORE_FUORI + "18" }}>
            <TriangleAlert className="w-3 h-3" />
            {fuoriTot} oltre {soglia} m · fino a {d.fuoriPercorso?.distanzaMassimaM} m
          </span>
        ) : (
          <span className="px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
            Nessuna posizione oltre {soglia} m dal percorso
          </span>
        )}
      </div>

      {/* Che cosa sia la linea grigia decide se questa mappa prova qualcosa.
          Perciò sta in testa, non in fondo. */}
      <div
        className={`px-3 py-2 rounded-lg text-[11px] leading-relaxed border ${
          d.riferimento?.tipo === "tracciato"
            ? "bg-white/5 border-border/50"
            : "bg-amber-500/10 border-amber-500/30 text-amber-200/90"
        }`}>
        {d.riferimento?.nota}
      </div>

      <div className="h-[420px] rounded-lg overflow-hidden border border-border/50 relative">
        {MAPBOX_TOKEN && bbox ? (
          <MapGL
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={{
              longitude: (bbox.minLon + bbox.maxLon) / 2,
              latitude: (bbox.minLat + bbox.maxLat) / 2,
              zoom: 12,
            }}
            style={{ width: "100%", height: "100%" }}
            mapStyle="mapbox://styles/mapbox/dark-v11"
            attributionControl={false}>

            {teorico.length >= 2 && (
              <Source id="teorico" type="geojson" data={linea(teorico)}>
                <Layer id="teorico-l" type="line"
                  paint={{
                    "line-color": COLORE_TEORICO, "line-width": 5, "line-opacity": 0.75,
                    /* Tratteggiata quando NON è la strada ma la corda fra le
                       fermate: la differenza deve vedersi sulla mappa, non solo
                       leggersi nella nota. */
                    ...(d.riferimento?.tipo === "fermate" ? { "line-dasharray": [2, 2] } : {}),
                  }} />
              </Source>
            )}

            {tratti.map((t, i) => (
              <Source key={i} id={`traccia-${i}`} type="geojson" data={linea(t.punti)}>
                <Layer id={`traccia-l-${i}`} type="line"
                  paint={{
                    "line-color": t.fuori ? COLORE_FUORI : COLORE_REALE,
                    "line-width": t.fuori ? 4 : 2.5,
                  }} />
              </Source>
            ))}

            <Source id="fermate" type="geojson" data={puntiFermate(d.fermate ?? [])}>
              <Layer id="fermate-l" type="circle"
                paint={{
                  "circle-radius": 4,
                  /* Piena = transito rilevato, vuota = nessun passaggio
                     registrato: sulla mappa è la stessa distinzione che il
                     dettaglio corsa fa in tabella. */
                  "circle-color": ["case", ["get", "osservata"], "#34d399", "transparent"],
                  "circle-stroke-width": 1.5,
                  "circle-stroke-color": ["case", ["get", "osservata"], "#34d399", "#94a3b8"],
                }} />
            </Source>
          </MapGL>
        ) : (
          <SchemaSenzaStrade teorico={teorico} tratti={tratti} bbox={bbox}
            fermate={d.fermate ?? []}
            tratteggiato={d.riferimento?.tipo === "fermate"} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground px-1">
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-0.5" style={{ background: COLORE_TEORICO }} />
          {d.riferimento?.tipo === "tracciato" ? "percorso previsto" : "fermate unite in retta"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-0.5" style={{ background: COLORE_REALE }} /> dove è passato
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-0.5" style={{ background: COLORE_FUORI }} /> oltre {soglia} m
        </span>
        <span className="flex items-center gap-1.5">
          <MapPin className="w-3 h-3 text-emerald-400" /> fermata con transito rilevato
        </span>
        {!MAPBOX_TOKEN && (
          <span className="ml-auto text-amber-300/80">
            Senza VITE_MAPBOX_TOKEN: schema senza strade
          </span>
        )}
      </div>
    </div>
  );
}

const linea = (p: Punto[]) => ({
  type: "Feature" as const, properties: {},
  geometry: { type: "LineString" as const, coordinates: p.map(x => [x.lon, x.lat]) },
});

const puntiFermate = (f: FermataMappa[]) => ({
  type: "FeatureCollection" as const,
  features: f.filter(x => x.lat != null && x.lon != null).map(x => ({
    type: "Feature" as const,
    properties: { osservata: x.osservata, nome: x.stopName ?? x.stopId },
    geometry: { type: "Point" as const, coordinates: [x.lon!, x.lat!] },
  })),
});

/* ── Ripiego senza basemap ──────────────────────────────────────────────────
 * Le stesse due linee, proiettate su un piano locale. Non dice su quale via
 * il mezzo sia passato — per quello servono le strade — ma dice se lo
 * scostamento è un'ansa larga o un salto altrove, che è già metà della
 * risposta. */
function SchemaSenzaStrade({
  teorico, tratti, bbox, fermate, tratteggiato,
}: {
  teorico: Punto[];
  tratti: Array<{ fuori: boolean; punti: Punto[] }>;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
  fermate: FermataMappa[];
  tratteggiato: boolean;
}) {
  if (!bbox) return null;
  const W = 600, H = 420, PAD = 20;
  /* La longitudine si accorcia col coseno della latitudine: ignorarlo
   * schiaccerebbe la mappa del 25% alle nostre latitudini e farebbe sembrare
   * una deviazione laterale più piccola di quanto è. */
  const kLon = Math.cos(((bbox.minLat + bbox.maxLat) / 2) * Math.PI / 180);
  const dLon = Math.max(1e-6, (bbox.maxLon - bbox.minLon) * kLon);
  const dLat = Math.max(1e-6, bbox.maxLat - bbox.minLat);
  const scala = Math.min((W - 2 * PAD) / dLon, (H - 2 * PAD) / dLat);
  const x = (p: Punto) => PAD + (p.lon - bbox.minLon) * kLon * scala;
  const y = (p: Punto) => H - PAD - (p.lat - bbox.minLat) * scala;
  const d = (p: Punto[]) => p.map((q, i) => `${i ? "L" : "M"}${x(q).toFixed(1)},${y(q).toFixed(1)}`).join(" ");

  /* Una scala, perché senza strade la forma da sola non dice quanto è grande
   * lo scostamento: "due centimetri sullo schermo" non si confronta con i
   * metri scritti in alto, e sono quelli a decidere se è un caso vero. */
  const metriPerPixel = 1 / (scala / 111_320);
  const passi = [100, 200, 500, 1000, 2000, 5000, 10_000];
  const metri = passi.find(m => m / metriPerPixel > 60) ?? passi[passi.length - 1];
  const barraPx = metri / metriPerPixel;
  const etichetta = metri >= 1000 ? `${metri / 1000} km` : `${metri} m`;

  const viste = fermate.filter(f => f.lat != null && f.lon != null);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {teorico.length >= 2 && (
        <path d={d(teorico)} fill="none" stroke={COLORE_TEORICO} strokeWidth="4"
          strokeLinejoin="round" opacity={0.8}
          strokeDasharray={tratteggiato ? "6 5" : undefined} />
      )}
      {tratti.map((t, i) => (
        <path key={i} d={d(t.punti)} fill="none"
          stroke={t.fuori ? COLORE_FUORI : COLORE_REALE}
          strokeWidth={t.fuori ? 3.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {/* Le fermate ci sono anche qui: la legenda le nomina, e una legenda che
          nomina qualcosa che non si vede fa cercare ciò che non c'è. */}
      {viste.map(f => (
        <circle key={f.stopId + f.seq}
          cx={x({ lat: f.lat!, lon: f.lon! })} cy={y({ lat: f.lat!, lon: f.lon! })} r="3.5"
          fill={f.osservata ? "#34d399" : "none"}
          stroke={f.osservata ? "#34d399" : "#94a3b8"} strokeWidth="1.5">
          <title>{`${f.stopName ?? f.stopId}${f.osservata ? " · transito rilevato" : " · nessun transito"}`}</title>
        </circle>
      ))}
      <g transform={`translate(${PAD}, ${H - 8})`}>
        <line x1={0} y1={0} x2={barraPx} y2={0} stroke="#94a3b8" strokeWidth="1.5" />
        <line x1={0} y1={-3} x2={0} y2={3} stroke="#94a3b8" strokeWidth="1.5" />
        <line x1={barraPx} y1={-3} x2={barraPx} y2={3} stroke="#94a3b8" strokeWidth="1.5" />
        <text x={barraPx + 6} y={3} fill="#94a3b8" fontSize="10">{etichetta}</text>
      </g>
    </svg>
  );
}
