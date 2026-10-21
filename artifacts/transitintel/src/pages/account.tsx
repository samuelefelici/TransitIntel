/**
 * Sicurezza dell'account: cambio della password, verifica in due passaggi
 * (attivazione con il QR, codici di recupero, disattivazione dove il ruolo lo
 * permette), uscita da tutti gli altri dispositivi.
 *
 * Con una sessione «limitata» (password provvisoria, verifica obbligatoria da
 * attivare) l'app mostra solo questa pagina: `forzata` aggiunge l'avviso e il
 * pulsante per uscire, perché il menu non c'è.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { KeyRound, LifeBuoy, LogOut, MonitorSmartphone, ShieldAlert, ShieldCheck, Smartphone } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/* stessa regola del server (api-server/src/lib/password-regole.ts) */
const PASSWORD_MIN = 12;

export default function AccountPage({ forzata = false }: { forzata?: boolean }) {
  const { user, accesso, refresh, logout } = useAuth();
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">
        <header className="flex flex-wrap items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold">Sicurezza dell'account</h1>
            <p className="text-sm text-muted-foreground truncate">{user?.email}</p>
          </div>
          {forzata && (
            <Button variant="outline" size="sm" onClick={() => void logout().then(() => navigate("/", { replace: true }))}>
              <LogOut className="w-4 h-4 mr-1.5" /> Esci
            </Button>
          )}
        </header>

        {accesso?.limitato && (
          <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm flex gap-3">
            <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" aria-hidden />
            <p>
              {accesso.limitato === "password"
                ? "La password che hai ricevuto è provvisoria: scegline una tua per continuare."
                : "Per il tuo ruolo serve la verifica in due passaggi: attivala qui sotto per continuare. Ti serve un'app di autenticazione sul telefono (Google Authenticator, Microsoft Authenticator o simili)."}
            </p>
          </div>
        )}

        {accesso?.recupero && <TelefonoPerso onFatto={refresh} />}
        <CambioPassword onFatto={refresh} evidenziata={accesso?.limitato === "password"} />
        {accesso?.limitato !== "password" && <VerificaDueFattori onCambio={refresh} />}
        {!accesso?.limitato && <Sessioni />}
      </div>
    </div>
  );
}

function CambioPassword({ onFatto, evidenziata }: { onFatto: () => Promise<void>; evidenziata: boolean }) {
  const [attuale, setAttuale] = useState("");
  const [nuova, setNuova] = useState("");
  const [conferma, setConferma] = useState("");
  const [busy, setBusy] = useState(false);

  const invia = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nuova !== conferma) { toast.error("Le due password nuove non coincidono"); return; }
    if (nuova.length < PASSWORD_MIN) { toast.error(`Almeno ${PASSWORD_MIN} caratteri`); return; }
    setBusy(true);
    try {
      await apiFetch("/api/auth/password", { method: "POST", body: JSON.stringify({ attuale, nuova }) });
      toast.success("Password cambiata. Le altre sessioni sono state chiuse.");
      setAttuale(""); setNuova(""); setConferma("");
      await onFatto();
    } catch (e: any) {
      toast.error("Password non cambiata", { description: e?.message });
    } finally { setBusy(false); }
  };

  return (
    <Card className={evidenziata ? "border-amber-500/60" : undefined}>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><KeyRound className="w-4 h-4" aria-hidden /> Password</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={invia} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pwd-attuale">{evidenziata ? "Password provvisoria" : "Password attuale"}</Label>
            <Input id="pwd-attuale" type="password" autoComplete="current-password" value={attuale} onChange={e => setAttuale(e.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pwd-nuova">Password nuova</Label>
            <Input id="pwd-nuova" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} aria-describedby="pwd-regola"
              value={nuova} onChange={e => setNuova(e.target.value)} required />
            <p id="pwd-regola" className="text-xs text-muted-foreground">
              Almeno {PASSWORD_MIN} caratteri. Meglio una frase di più parole; niente nome, email o password comuni.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pwd-conferma">Ripeti la password nuova</Label>
            <Input id="pwd-conferma" type="password" autoComplete="new-password" value={conferma} onChange={e => setConferma(e.target.value)} required />
          </div>
          <div><Button type="submit" disabled={busy}>{busy ? "Salvataggio…" : "Cambia password"}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function VerificaDueFattori({ onCambio }: { onCambio: () => Promise<void> }) {
  const { accesso } = useAuth();
  /* attivazione in corso: il segreto, il QR e il codice da confermare */
  const [nuovo, setNuovo] = useState<{ segreto: string; qr: string } | null>(null);
  const [codice, setCodice] = useState("");
  const [codiciRecupero, setCodiciRecupero] = useState<string[] | null>(null);
  const [azione, setAzione] = useState<"disattiva" | "codici" | null>(null);
  const [busy, setBusy] = useState(false);
  /* se la password non è stata data da poco, il server la richiede prima di legare un telefono */
  const [chiediPassword, setChiediPassword] = useState(false);
  const [password, setPassword] = useState("");

  const inizia = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const r = await apiFetch<{ segreto: string; uri: string }>("/api/auth/mfa/attiva", {
        method: "POST", body: JSON.stringify(chiediPassword ? { password } : {}),
      });
      const QRCode = (await import("qrcode")).default;
      setNuovo({ segreto: r.segreto, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220 }) });
      setCodice("");
      setPassword(""); setChiediPassword(false);
    } catch (e: any) {
      if (e?.body?.serve === "password" && !chiediPassword) setChiediPassword(true);
      else toast.error("Verifica non avviata", { description: e?.message });
    } finally { setBusy(false); }
  };

  const conferma = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await apiFetch<{ codiciRecupero: string[] }>("/api/auth/mfa/conferma", { method: "POST", body: JSON.stringify({ codice }) });
      setNuovo(null);
      setCodiciRecupero(r.codiciRecupero);
      toast.success("Verifica in due passaggi attiva");
    } catch (e: any) {
      toast.error("Codice non accettato", { description: e?.message });
    } finally { setBusy(false); }
  };

  const conCodice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!azione) return;
    setBusy(true);
    try {
      if (azione === "disattiva") {
        await apiFetch("/api/auth/mfa/disattiva", { method: "POST", body: JSON.stringify({ codice }) });
        toast.success("Verifica in due passaggi disattivata");
        await onCambio();
      } else {
        const r = await apiFetch<{ codiciRecupero: string[] }>("/api/auth/mfa/codici-recupero", { method: "POST", body: JSON.stringify({ codice }) });
        setCodiciRecupero(r.codiciRecupero);
      }
      setAzione(null); setCodice("");
    } catch (e: any) {
      toast.error("Codice non accettato", { description: e?.message });
    } finally { setBusy(false); }
  };

  const chiudiCodici = async () => { setCodiciRecupero(null); await onCambio(); };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Smartphone className="w-4 h-4" aria-hidden /> Verifica in due passaggi</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          {accesso?.mfaAttiva
            ? "Attiva: a ogni accesso, dopo la password, ti chiediamo il codice dell'app."
            : "Non attiva. Dopo la password ti chiederemo un codice a 6 cifre che cambia ogni 30 secondi nell'app del telefono."}
          {accesso?.mfaObbligatoria && " Per il tuo ruolo è obbligatoria."}
        </p>

        {accesso?.mfaAttiva && accesso.codiciDaRifare && !codiciRecupero && (
          <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            I tuoi codici di recupero sono di prima di un aggiornamento della sicurezza e presto non varranno più: fanne di nuovi qui sotto.
          </p>
        )}

        {codiciRecupero && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4 space-y-3">
            <p className="font-medium">Codici di recupero: salvali ora, non li vedrai più.</p>
            <p className="text-muted-foreground">Ognuno vale una volta, se perdi il telefono. Stampali o tienili in un gestore di password.</p>
            <ul className="grid grid-cols-2 gap-1.5 font-mono tabular-nums">
              {codiciRecupero.map(c => <li key={c} className="rounded bg-muted px-2 py-1 text-center">{c}</li>)}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(codiciRecupero.join("\n")); toast.success("Codici copiati"); }}>Copia</Button>
              <Button type="button" size="sm" onClick={() => void chiudiCodici()}>Li ho salvati</Button>
            </div>
          </div>
        )}

        {!accesso?.mfaAttiva && !codiciRecupero && (
          nuovo ? (
            <form onSubmit={conferma} className="space-y-3">
              <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
                <li>Apri l'app di autenticazione e aggiungi un account inquadrando il QR.</li>
                <li>Se non puoi inquadrarlo, inserisci a mano la chiave qui sotto.</li>
                <li>Scrivi il codice a 6 cifre che compare nell'app.</li>
              </ol>
              <div className="flex flex-wrap items-center gap-4">
                <img src={nuovo.qr} alt="QR da inquadrare con l'app di autenticazione" width={220} height={220} className="rounded-md bg-white p-1" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Chiave</p>
                  <p className="font-mono text-sm break-all select-all">{nuovo.segreto.match(/.{1,4}/g)?.join(" ")}</p>
                </div>
              </div>
              <div className="grid gap-1.5 max-w-48">
                <Label htmlFor="mfa-codice">Codice dell'app</Label>
                <Input id="mfa-codice" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={codice}
                  onChange={e => setCodice(e.target.value)} required className="font-mono tracking-widest text-center" />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>{busy ? "Verifica…" : "Attiva"}</Button>
                <Button type="button" variant="ghost" onClick={() => setNuovo(null)}>Annulla</Button>
              </div>
            </form>
          ) : chiediPassword ? (
            <form onSubmit={inizia} className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="mfa-password">Per sicurezza, la tua password</Label>
                <Input id="mfa-password" type="password" autoComplete="current-password" value={password}
                  onChange={e => setPassword(e.target.value)} required className="w-64" />
              </div>
              <Button type="submit" disabled={busy}>{busy ? "Verifica…" : "Continua"}</Button>
              <Button type="button" variant="ghost" onClick={() => { setChiediPassword(false); setPassword(""); }}>Annulla</Button>
            </form>
          ) : (
            <Button type="button" onClick={() => void inizia()} disabled={busy}>Attiva la verifica</Button>
          )
        )}

        {accesso?.mfaAttiva && !codiciRecupero && (
          azione ? (
            <form onSubmit={conCodice} className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="mfa-codice-azione">Codice dell'app</Label>
                <Input id="mfa-codice-azione" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={codice}
                  onChange={e => setCodice(e.target.value)} required className="w-36 font-mono tracking-widest text-center" />
              </div>
              <Button type="submit" disabled={busy} variant={azione === "disattiva" ? "destructive" : "default"}>
                {azione === "disattiva" ? "Disattiva" : "Rifai i codici"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => { setAzione(null); setCodice(""); }}>Annulla</Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setAzione("codici")}>Nuovi codici di recupero</Button>
              {!accesso.mfaObbligatoria && (
                <Button type="button" variant="outline" size="sm" onClick={() => setAzione("disattiva")}>Disattiva</Button>
              )}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

/** Entrato con un codice di recupero: la password, e la verifica si rifà col telefono nuovo. */
function TelefonoPerso({ onFatto }: { onFatto: () => Promise<void> }) {
  const { accesso } = useAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const invia = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch("/api/auth/mfa/reimposta", { method: "POST", body: JSON.stringify({ password }) });
      toast.success(accesso?.mfaObbligatoria
        ? "Verifica tolta: attivala ora con il telefono nuovo"
        : "Verifica tolta: se vuoi, riattivala con il telefono nuovo");
      setPassword("");
      await onFatto();
    } catch (e: any) {
      toast.error("Non riuscito", { description: e?.message });
    } finally { setBusy(false); }
  };
  return (
    <Card className="border-amber-500/60">
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><LifeBuoy className="w-4 h-4" aria-hidden /> Hai perso il telefono?</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Per entrare hai usato un codice di recupero. Se il telefono con l'app non ce l'hai più, rifai la verifica con quello
          nuovo: inserisci la password, poi inquadri il QR nuovo. Il vecchio telefono smette di valere, e anche i codici di recupero rimasti.
        </p>
        <form onSubmit={invia} className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="recupero-password">Password</Label>
            <Input id="recupero-password" type="password" autoComplete="current-password" value={password}
              onChange={e => setPassword(e.target.value)} required className="w-64" />
          </div>
          <Button type="submit" disabled={busy}>{busy ? "Attendi…" : "Rifai la verifica"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Sessioni() {
  const [busy, setBusy] = useState(false);
  const chiudi = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/auth/sessioni/chiudi", { method: "POST" });
      toast.success("Fatto: sugli altri dispositivi bisogna entrare di nuovo");
    } catch (e: any) {
      toast.error("Non riuscito", { description: e?.message });
    } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><MonitorSmartphone className="w-4 h-4" aria-hidden /> Sessioni</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">Una sessione dura al massimo 12 ore. Se hai lasciato Cerbero aperto su un altro computer, chiudilo da qui.</p>
        <Button type="button" variant="outline" onClick={() => void chiudi()} disabled={busy}>Esci da tutti gli altri dispositivi</Button>
      </CardContent>
    </Card>
  );
}
