/**
 * Apre FleetCare: chiede a Cerbero il biglietto (60 secondi, una volta sola)
 * e porta il browser di là, già dentro. È l'indirizzo del pulsante «Entra
 * con Cerbero» di FleetCare: chi non è ancora entrato in Cerbero passa prima
 * dal login (App.tsx lo riporta qui dopo l'accesso).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Loader2, Wrench } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";

export default function ApriFleetCare() {
  const [errore, setErrore] = useState<string | null>(null);
  /* tornati qui con Indietro da FleetCare: non si riparte da soli, si chiede */
  const [tornato, setTornato] = useState(false);
  const partito = useRef(false);

  const apri = useCallback(() => {
    setErrore(null);
    setTornato(false);
    /* la pagina di FleetCare chiesta prima dell'accesso (?da=): FleetCare la ricontrolla */
    const da = new URLSearchParams(window.location.search).get("da");
    apiFetch<{ url: string }>("/api/auth/fleetcare-sso", {
      method: "POST",
      body: JSON.stringify(da ? { da } : {}),
    })
      .then(r => {
        /* replace: tornando indietro da FleetCare non si riparte da qui */
        window.location.replace(r.url);
      })
      .catch((e: any) => {
        /* 401: AuthProvider riporta al login; 403 di sessione limitata: App mostra la pagina dell'account */
        if (e?.status === 401 || e?.body?.accessoLimitato) return;
        setErrore(e?.status === 403
          ? "Non sei abilitato a FleetCare: chiedi all'amministratore di darti il permesso."
          : e?.status === 503
            ? "FleetCare non è configurato su questa installazione di Cerbero."
            : e?.message || "FleetCare non risponde: riprova fra poco.");
      });
  }, []);

  useEffect(() => {
    /* una richiesta sola, anche se React monta due volte l'effetto */
    if (partito.current) return;
    partito.current = true;
    apri();
  }, [apri]);

  useEffect(() => {
    /* la pagina riappare dalla cache del browser (bfcache) tornando indietro */
    const ritorno = (e: PageTransitionEvent) => { if (e.persisted) setTornato(true); };
    window.addEventListener("pageshow", ritorno);
    return () => window.removeEventListener("pageshow", ritorno);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center space-y-4">
        <Wrench className="w-8 h-8 mx-auto text-sky-400" aria-hidden />
        {errore ? (
          <>
            <p role="alert" className="text-sm">{errore}</p>
            <Link href="/dashboard" className="text-sm text-primary underline">Vai a Cerbero</Link>
          </>
        ) : tornato ? (
          <div className="flex flex-col items-center gap-3">
            <Button type="button" onClick={apri}>Apri FleetCare</Button>
            <Link href="/dashboard" className="text-sm text-primary underline">Vai a Cerbero</Link>
          </div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Apro FleetCare…
          </p>
        )}
      </div>
    </div>
  );
}
