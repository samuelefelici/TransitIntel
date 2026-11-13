/**
 * Azienda (Amministrazione, solo admin): i dati dell'azienda che usa questa
 * installazione. Prima erano scritti nel codice; ora stanno in public.azienda
 * (migrazione 0014) e li usano i GTFS esportati, i documenti stampati, le
 * regole delle password e le mappe di tutta la rete.
 * API: GET e PUT /api/admin/azienda. La logica del modulo è in lib/azienda.ts.
 */
import { useEffect, useMemo, useState } from "react";
import { Building2, MapPin, Save } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  aziendaValida, datiDaSalvare, erroriDelModulo, moduloCambiato, moduloDa,
  type Azienda, type CampoAzienda, type ModuloAzienda,
} from "@/lib/azienda";

interface Dettaglio { azienda: Azienda; aggiornataIl: string | null; aggiornataDa: string | null }

const quando = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("it-IT", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

export default function AdminAziendaPage() {
  const { toast } = useToast();
  const { refresh } = useAuth();
  const [dettaglio, setDettaglio] = useState<Dettaglio | null>(null);
  const [salvato, setSalvato] = useState<ModuloAzienda | null>(null);
  const [modulo, setModulo] = useState<ModuloAzienda | null>(null);
  const [busy, setBusy] = useState(false);
  /* gli errori si mostrano dopo il primo tentativo di salvare, o sulle caselle già toccate */
  const [toccati, setToccati] = useState<Set<CampoAzienda>>(new Set());
  const [provato, setProvato] = useState(false);

  const accogli = (d: Dettaglio) => {
    const pulito = { ...d, azienda: aziendaValida(d.azienda) };
    setDettaglio(pulito);
    const m = moduloDa(pulito.azienda);
    setSalvato(m); setModulo(m); setToccati(new Set()); setProvato(false);
  };

  useEffect(() => {
    apiFetch<Dettaglio>("/api/admin/azienda")
      .then(accogli)
      .catch((e: any) => toast({ title: "Dati dell'azienda non letti", description: e?.message, variant: "destructive" }));
  }, [toast]);

  const errori = useMemo(() => (modulo ? erroriDelModulo(modulo) : {}), [modulo]);
  const cambiato = !!modulo && !!salvato && moduloCambiato(modulo, salvato);
  const daCompilare = dettaglio !== null && !dettaglio.azienda.compilata;

  const salva = async () => {
    if (!modulo) return;
    setProvato(true);
    if (Object.keys(errori).length > 0) return;
    setBusy(true);
    try {
      accogli(await apiFetch<Dettaglio>("/api/admin/azienda", { method: "PUT", body: JSON.stringify(datiDaSalvare(modulo)) }));
      toast({ title: "Dati dell'azienda salvati", description: "Chi è già dentro li vede al prossimo caricamento della pagina." });
      /* la sessione porta i dati dell'azienda: la barra laterale e le mappe di questa scheda si aggiornano */
      void refresh();
    } catch (e: any) {
      toast({ title: "Non salvato", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const casella = (campo: CampoAzienda, etichetta: string, opzioni: { aiuto?: string; facoltativo?: boolean; larghezza?: string; tipo?: string; esempio?: string } = {}) => {
    const errore = (provato || toccati.has(campo)) ? errori[campo] : undefined;
    const id = `azienda-${campo}`;
    return (
      <div className={opzioni.larghezza ?? ""}>
        <Label htmlFor={id}>
          {etichetta}{opzioni.facoltativo && <span className="text-muted-foreground font-normal"> (facoltativo)</span>}
        </Label>
        <Input
          id={id}
          type={opzioni.tipo === "decimale" ? "text" : opzioni.tipo ?? "text"}
          inputMode={opzioni.tipo === "decimale" ? "decimal" : undefined}
          value={modulo?.[campo] ?? ""}
          placeholder={opzioni.esempio}
          disabled={!modulo || busy}
          onChange={e => setModulo(m => (m ? { ...m, [campo]: e.target.value } : m))}
          onBlur={() => setToccati(t => new Set(t).add(campo))}
          aria-invalid={!!errore}
          aria-describedby={errore ? `${id}-errore` : opzioni.aiuto ? `${id}-aiuto` : undefined}
        />
        {errore
          ? <p id={`${id}-errore`} role="alert" className="text-xs text-destructive mt-1">{errore}</p>
          : opzioni.aiuto && <p id={`${id}-aiuto`} className="text-xs text-muted-foreground mt-1">{opzioni.aiuto}</p>}
      </div>
    );
  };

  const ultimo = quando(dettaglio?.aggiornataIl ?? null);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Building2 className="w-6 h-6 text-primary" aria-hidden /> Azienda
        </h1>
        <p className="text-sm text-muted-foreground">
          I dati dell'azienda che usa questa installazione. Finiscono nei GTFS esportati, nei documenti stampati e nelle mappe.
        </p>
      </div>

      {daCompilare && (
        <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <strong>Da compilare.</strong> Finché non salvi questi dati, i GTFS escono con il nome «Azienda di trasporto» e le mappe si aprono sull'Italia.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" aria-hidden /> Identità
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {casella("ragioneSociale", "Ragione sociale", { larghezza: "sm:col-span-2", aiuto: "Il nome per esteso: è l'agenzia e l'editore dei GTFS esportati dagli scenari.", esempio: "Trasporti Esempio S.p.A." })}
          {casella("nome", "Nome", { aiuto: "Il nome corto, per le intestazioni dei documenti.", esempio: "Esempio" })}
          {casella("gtfsAgencyId", "Identificativo GTFS", { aiuto: "L'agency_id dei GTFS esportati dagli scenari. Cambiarlo cambia l'identità dell'agenzia per chi li riceve.", esempio: "esempio" })}
          {casella("sito", "Sito", { facoltativo: true, tipo: "url", aiuto: "Va nei GTFS come indirizzo dell'agenzia.", esempio: "https://www.esempio.it" })}
          {casella("telefono", "Telefono", { facoltativo: true, tipo: "tel", aiuto: "Va nei GTFS esportati dagli scenari.", esempio: "+39 071 000000" })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="w-4 h-4 text-primary" aria-hidden /> Territorio
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {casella("citta", "Città principale", { aiuto: "Compare nelle intestazioni. Il nome dell'azienda e la città non bastano come password.", esempio: "Ancona" })}
            {casella("regione", "Regione", { facoltativo: true, esempio: "Marche" })}
          </div>
          <div>
            <p className="text-sm font-medium mb-2">Centro delle mappe</p>
            <div className="grid gap-4 sm:grid-cols-3">
              {casella("centroLat", "Latitudine", { tipo: "decimale", esempio: "43.58" })}
              {casella("centroLng", "Longitudine", { tipo: "decimale", esempio: "13.45" })}
              {casella("zoom", "Zoom", { tipo: "decimale", aiuto: "Da 3 (un continente) a 18 (una via). Per una provincia: 10.", esempio: "10" })}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Dove si aprono le mappe di tutta la rete: la mappa della pagina iniziale, la Mappa live e gli Scenari.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void salva()} disabled={busy || !modulo || !cambiato}>
          <Save className="w-4 h-4 mr-1.5" aria-hidden /> {busy ? "Salvataggio…" : "Salva"}
        </Button>
        {cambiato && !busy && (
          <Button variant="ghost" onClick={() => { setModulo(salvato); setToccati(new Set()); setProvato(false); }}>Annulla le modifiche</Button>
        )}
        <p className="text-xs text-muted-foreground">
          {provato && Object.keys(errori).length > 0
            ? "Correggi le caselle segnate, poi salva."
            : ultimo
              ? `Salvati il ${ultimo}${dettaglio?.aggiornataDa ? ` da ${dettaglio.aggiornataDa}` : ""}.`
              : dettaglio && !daCompilare ? "Valori di partenza, mai modificati da qui." : ""}
        </p>
      </div>
    </div>
  );
}
