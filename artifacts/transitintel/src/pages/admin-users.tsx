import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { voceAdminLeggibile } from "@/lib/registro-admin";
import { useAuth } from "@/hooks/use-auth";
import {
  AREE, DESCRIZIONI_AREE, INTERRUTTORI_DI_PRIMA, MATRICE, NOMI_AREE, NOMI_RUOLI, RUOLI, RUOLO_FLEETCARE_SUGGERITO,
  dirittiDi, haAccessoDiPrima, puo, rigaDelRuolo, vedeDatiSanitari,
  type Diritti, type InterruttoreDiPrima, type Matrice, type RuoloAziendale,
} from "@workspace/permessi";
import { matriceDaRuoli, riassuntoDeiDiritti, ruoliValidi } from "@/lib/ruoli-admin";
import {
  conInterruttore, conModifica, conScelta, depositiDellUtente, depositiInBreve, elenchiDaSalvare, erroreDepositi, sceltaSul,
  type DepositiScelti, type SceltaDeposito,
} from "@/lib/depositi-utente";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Trash2, KeyRound, UserPlus, Shield, ShieldCheck } from "lucide-react";

/* stessa regola del server (api-server/src/lib/password-regole.ts): il server
 * controlla anche password comuni, sequenze e dati della persona */
const PASSWORD_MIN = 12;

interface AdminUser {
  id: string;
  email: string;
  fullName: string | null;
  /** "admin" è l'amministratore di sistema, non un ruolo di lavoro */
  role: "admin" | "user";
  ruoli: RuoloAziendale[];
  accessoDiPrima: Partial<Record<InterruttoreDiPrima, true>>;
  datiSanitari: boolean;
  analisi: boolean;
  /** i depositi di cui modifica i conducenti */
  depositi?: string[];
  /** i depositi di cui vede i conducenti; vuoto = tutti */
  depositiVisibili?: string[];
  /** lettura o scrittura per area, come li calcola il server */
  diritti: Diritti;
  fleetcareRole: string;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /* accesso sicuro (api-server/src/lib/auth.ts) */
  mfaAttiva?: boolean;
  mfaObbligatoria?: boolean;
  passwordDaCambiare?: boolean;
  bloccatoFino?: string | null;
  codiciDaRifare?: boolean;
}

interface VoceAccesso { id: string; ts: string; userId: string | null; email: string | null; esito: string; ip: string | null; userAgent: string | null }

/* gli esiti del registro, in parole */
const ESITO_LABEL: Record<string, string> = {
  ok: "entrato", ok_con_verifica: "entrato con la verifica", codice_richiesto: "password giusta, codice richiesto",
  password_errata: "password sbagliata", codice_errato: "codice sbagliato", recupero_errato: "codice di recupero sbagliato",
  recupero_usato: "codice di recupero usato", utente_sconosciuto: "email sconosciuta", utente_inattivo: "utente disattivato",
  bloccato: "bloccato (troppi tentativi)", password_pubblicata: "password pubblicata: disattivato",
  password_cambiata: "password cambiata", verifica_attivata: "verifica attivata", verifica_disattivata: "verifica disattivata",
  codici_recupero_nuovi: "nuovi codici di recupero", sessioni_chiuse: "uscito da tutti i dispositivi",
  codici_bloccati: "codici bloccati (troppi sbagliati)", segreto_illeggibile: "verifica non leggibile: controlla CERBERO_CHIAVE_MFA",
  password_attuale_errata: "password attuale sbagliata", verifica_reimpostata: "verifica rifatta dopo il telefono perso",
  bloccato_account: "account bloccato (errori da più indirizzi)",
  biglietto_fleetcare: "biglietto per FleetCare emesso",
};
const esitoLeggibile = (e: string) => voceAdminLeggibile(e) ?? ESITO_LABEL[e] ?? e;

/* I nomi degli interruttori di prima dei ruoli, per dire all'amministratore che cosa resta acceso */
const NOMI_INTERRUTTORI: Record<InterruttoreDiPrima, string> = {
  network: "Rete e orari", scheduling: "Turni", roster: "Roster", personale: "Personale",
  centrale: "Esercizio", fleetcare: "Flotta", fares: "Tariffe",
};

/** Che cosa si sceglie per i permessi di un utente (la stessa forma in creazione e in modifica). */
interface Scelte {
  role: "admin" | "user";
  ruoli: RuoloAziendale[];
  /** gli interruttori di prima che restano accesi (in modifica: si possono solo togliere) */
  accessoDiPrima: Partial<Record<InterruttoreDiPrima, true>>;
  datiSanitari: boolean;
  analisi: boolean;
  /** di quali depositi vede i conducenti e di quali li modifica (lib/depositi-utente.ts) */
  depositi: DepositiScelti;
  fleetcareRole: string;
}

const SCELTE_DEPOSITO: ReadonlyArray<[SceltaDeposito, string]> = [["niente", "Non vede"], ["vede", "Vede"], ["modifica", "Modifica"]];

/** Un deposito del catalogo del roster (GET /api/roster/depositi). */
interface DepositoCatalogo { codice: string; nome: string }

/* La matrice dei ruoli in vigore (quella di partenza con le modifiche fatte in
 * Amministrazione › Ruoli): l'anteprima di quello che un utente potrà fare deve
 * usare la stessa dell'API. Finché non arriva vale quella di partenza. */
const MatriceInVigore = createContext<Matrice>(MATRICE);

const dirittiDelleScelte = (s: Scelte, matrice: Matrice): Diritti =>
  dirittiDi({ admin: s.role === "admin", ruoli: s.ruoli, accessoDiPrima: s.accessoDiPrima, analisi: s.analisi, datiSanitari: s.datiSanitari }, matrice);

/** Ruoli disponibili DENTRO FleetCare (gli admin entrano sempre come Admin Flotta). */
const FLEETCARE_ROLE_LABEL: Record<string, string> = {
  driver: "Autista",
  mechanic: "Meccanico",
  workshop_manager: "Resp. Officina",
  admin_finance: "Amministrazione",
  fleet_admin: "Admin Flotta",
};

export default function AdminUsersPage() {
  const { isAdmin, user: me } = useAuth();
  const { toast } = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resetPwdFor, setResetPwdFor] = useState<AdminUser | null>(null);
  /* il catalogo dei depositi del roster: serve a limitare la scrittura di un Capo deposito ai suoi */
  const [depositi, setDepositi] = useState<DepositoCatalogo[]>([]);
  const [matrice, setMatrice] = useState<Matrice>(MATRICE);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch<{ users: AdminUser[] }>("/api/admin/users");
      setUsers(r.users);
    } catch (e: any) {
      toast({ title: "Errore", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  useEffect(() => {
    if (!isAdmin) return;
    let vivo = true;
    /* che cosa dà ogni ruolo adesso; se non si legge, l'anteprima usa i valori di partenza (decide comunque l'API) */
    apiFetch<unknown>("/api/admin/ruoli")
      .then(r => { if (vivo) setMatrice(matriceDaRuoli(ruoliValidi(r))); })
      .catch(() => { /* resta la matrice di partenza */ });
    return () => { vivo = false; };
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    let vivo = true;
    /* senza il catalogo la pagina funziona lo stesso: mancano solo le caselle dei depositi */
    apiFetch<{ depositi: DepositoCatalogo[] }>("/api/roster/depositi")
      .then(r => { if (vivo) setDepositi((r.depositi ?? []).map(d => ({ codice: d.codice, nome: d.nome }))); })
      .catch(() => { /* il roster può non essere pronto: i depositi già scelti si mostrano col loro codice */ });
    return () => { vivo = false; };
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold text-red-400">Accesso negato</h1>
        <p className="text-muted-foreground">Solo gli amministratori possono accedere a questa pagina.</p>
      </div>
    );
  }

  const handleDelete = async (u: AdminUser) => {
    if (u.id === me?.id) {
      toast({ title: "Operazione non consentita", description: "Non puoi eliminare te stesso.", variant: "destructive" });
      return;
    }
    if (!confirm(`Eliminare l'utente ${u.email}?`)) return;
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
      toast({ title: "Utente eliminato" });
      void load();
    } catch (e: any) {
      toast({ title: "Errore", description: e?.message, variant: "destructive" });
    }
  };

  /* telefono perso o troppi tentativi: due interventi dell'admin sull'accesso */
  const handleAccesso = async (u: AdminUser, corpo: { resetMfa: true } | { sblocca: true }, domanda: string, fatto: string) => {
    if (!confirm(domanda)) return;
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify(corpo) });
      toast({ title: fatto });
      void load();
    } catch (e: any) {
      toast({ title: "Errore", description: e?.message, variant: "destructive" });
    }
  };

  const handleToggleActive = async (u: AdminUser) => {
    try {
      await apiFetch(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !u.active }),
      });
      void load();
    } catch (e: any) {
      toast({ title: "Errore", description: e?.message, variant: "destructive" });
    }
  };

  const handleFleetcareRole = async (u: AdminUser, fleetcareRole: string) => {
    try {
      await apiFetch(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fleetcareRole }),
      });
      void load();
    } catch (e: any) {
      toast({ title: "Errore", description: e?.message, variant: "destructive" });
    }
  };

  return (
    <MatriceInVigore.Provider value={matrice}>
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-primary" />
            Gestione Utenti
          </h1>
          <p className="text-sm text-muted-foreground">
            Crea utenti, assegna i ruoli aziendali, resetta password.
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
            Un ruolo aziendale dà lettura o scrittura per area; con più ruoli vale il diritto più alto. Chi c'era prima dei ruoli
            tiene il suo «accesso di prima» finché non glielo spegni da «Modifica», dopo avergli dato i ruoli.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <UserPlus className="w-4 h-4 mr-2" /> Nuovo utente
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Utenti ({users.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-muted-foreground">Caricamento…</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-left text-muted-foreground">
                    <th className="py-2 pr-4">Email</th>
                    <th className="py-2 pr-4">Nome</th>
                    <th className="py-2 pr-4" title="Amministratore di sistema o utente: non è un ruolo di lavoro">Sistema</th>
                    <th className="py-2 pr-4">Attivo</th>
                    <th className="py-2 pr-4">Ruoli aziendali</th>
                    <th className="py-2 pr-4" title="Il ruolo dentro FleetCare, per chi può aprire la Flotta">FleetCare</th>
                    <th className="py-2 pr-4">Accesso</th>
                    <th className="py-2 pr-4">Ultimo login</th>
                    <th className="py-2 pr-4 text-right">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isAdminRow = u.role === "admin";
                    return (
                      <tr key={u.id} className="border-b border-border/20 hover:bg-muted/20">
                        <td className="py-2 pr-4 font-mono text-xs">
                          {u.email}
                          {u.id === me?.id && <span className="ml-1 text-primary">(tu)</span>}
                        </td>
                        <td className="py-2 pr-4">{u.fullName || "—"}</td>
                        <td className="py-2 pr-4">
                          {isAdminRow ? (
                            <span className="inline-flex items-center gap-1 text-amber-400">
                              <ShieldCheck className="w-3.5 h-3.5" /> admin
                            </span>
                          ) : (
                            <span className="text-muted-foreground">utente</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <Switch
                            checked={u.active}
                            disabled={u.id === me?.id}
                            onCheckedChange={() => handleToggleActive(u)}
                          />
                        </td>
                        <td className="py-2 pr-4">
                          <RuoliInBreve u={u} depositi={depositi} />
                        </td>
                        {/* FleetCare: il ruolo dentro il modulo, per chi può aprire la Flotta.
                            Gli admin entrano sempre (come fleet_admin). */}
                        <td className="py-2 pr-4">
                          {isAdminRow ? (
                            <span className="text-xs text-amber-400/80">Admin Flotta</span>
                          ) : puo(u.diritti, "flotta", "L") ? (
                            <select
                              className="bg-background border border-border rounded-md h-7 px-1 text-xs"
                              value={u.fleetcareRole || "driver"}
                              onChange={(e) => handleFleetcareRole(u, e.target.value)}
                              aria-label={`Ruolo di ${u.email} dentro FleetCare`}
                            >
                              {Object.entries(FLEETCARE_ROLE_LABEL).map(([v, l]) => (
                                <option key={v} value={v}>{l}</option>
                              ))}
                            </select>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-4 text-xs whitespace-nowrap">
                          <div className={u.mfaAttiva ? "text-emerald-400" : u.mfaObbligatoria ? "text-amber-400" : "text-muted-foreground"}>
                            {u.mfaAttiva ? "verifica attiva" : u.mfaObbligatoria ? "verifica da attivare" : "solo password"}
                          </div>
                          {u.passwordDaCambiare && <div className="text-amber-400">password provvisoria</div>}
                          {u.codiciDaRifare && <div className="text-amber-400">codici di recupero da rifare</div>}
                          {u.bloccatoFino && <div className="text-red-400">bloccato fino al {new Date(u.bloccatoFino).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>}
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground">
                          {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("it-IT") : "mai"}
                        </td>
                        <td className="py-2 pr-4 text-right space-x-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditing(u)}
                            title="Modifica"
                          >
                            Modifica
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setResetPwdFor(u)}
                            title="Reset password"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </Button>
                          {u.mfaAttiva && (
                            <Button size="sm" variant="outline" title="Toglie la verifica in due passaggi (telefono perso). Se per il suo ruolo è obbligatoria, al prossimo accesso dovrà riattivarla"
                              onClick={() => handleAccesso(u, { resetMfa: true }, `Togliere la verifica in due passaggi a ${u.email}? Le sue sessioni si chiudono${u.mfaObbligatoria ? " e al prossimo accesso dovrà riattivarla" : "; potrà riattivarla quando vuole"}.`, "Verifica tolta")}>
                              Reimposta verifica
                            </Button>
                          )}
                          {u.bloccatoFino && (
                            <Button size="sm" variant="outline" title="Toglie il blocco dopo i tentativi falliti"
                              onClick={() => handleAccesso(u, { sblocca: true }, `Sbloccare ${u.email}?`, "Utente sbloccato")}>
                              Sblocca
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(u)}
                            disabled={u.id === me?.id}
                            title="Elimina"
                            className="text-red-400 hover:text-red-300"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <RegistroAccessi />

      {showCreate && (
        <CreateUserDialog
          depositi={depositi}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}

      {editing && (
        <EditUserDialog
          user={editing}
          depositi={depositi}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {resetPwdFor && (
        <ResetPasswordDialog
          user={resetPwdFor}
          sonoIo={resetPwdFor.id === me?.id}
          onClose={() => setResetPwdFor(null)}
          onDone={() => {
            setResetPwdFor(null);
            void load();
          }}
        />
      )}
    </div>
    </MatriceInVigore.Provider>
  );
}

/* ─── Dialogs ─── */

function CreateUserDialog({ onClose, onCreated, depositi }: { onClose: () => void; onCreated: () => void; depositi: DepositoCatalogo[] }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  /* un utente nuovo ha solo quello che gli danno i ruoli: nessun accesso di prima */
  const [scelte, setScelte] = useState<Scelte>({ role: "user", ruoli: [], accessoDiPrima: {}, datiSanitari: false, analisi: false, depositi: depositiDellUtente({}), fleetcareRole: "driver" });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email || !password) {
      toast({ title: "Email e password obbligatori", variant: "destructive" });
      return;
    }
    if (password.length < PASSWORD_MIN) {
      toast({ title: `Password troppo corta (almeno ${PASSWORD_MIN} caratteri)`, variant: "destructive" });
      return;
    }
    const sbagliati = scelte.role === "admin" ? null : erroreDepositi(scelte.depositi);
    if (sbagliati) { toast({ title: "Depositi del roster", description: sbagliati, variant: "destructive" }); return; }
    setBusy(true);
    try {
      await apiFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email, fullName, password, role: scelte.role, ruoli: scelte.ruoli,
          datiSanitari: scelte.datiSanitari, analisi: scelte.analisi, ...elenchiDaSalvare(scelte.depositi), fleetcareRole: scelte.fleetcareRole,
        }),
      });
      toast({ title: "Utente creato" });
      onCreated();
    } catch (e: any) {
      toast({ title: "Errore", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuovo utente</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="nuovo-utente-email">Email</Label>
            <Input id="nuovo-utente-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nuovo-utente-nome">Nome completo</Label>
            <Input id="nuovo-utente-nome" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nuovo-utente-password">Password</Label>
            <Input id="nuovo-utente-password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN}
              aria-describedby="nuovo-utente-password-regola"
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <p id="nuovo-utente-password-regola" className="text-xs text-muted-foreground mt-1">
              Almeno {PASSWORD_MIN} caratteri. Meglio una frase di più parole; niente nome, email o password comuni.
            </p>
          </div>
          <PermessiUtente scelte={scelte} onChange={setScelte} prefisso="nuovo-utente" depositi={depositi} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Creazione…" : "Crea"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  depositi,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  /** il catalogo dei depositi del roster */
  depositi: DepositoCatalogo[];
  
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [fullName, setFullName] = useState(user.fullName || "");
  const [scelte, setScelte] = useState<Scelte>({
    role: user.role, ruoli: user.ruoli ?? [], accessoDiPrima: user.accessoDiPrima ?? {},
    datiSanitari: !!user.datiSanitari, analisi: !!user.analisi, depositi: depositiDellUtente(user), fleetcareRole: user.fleetcareRole || "driver",
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const sbagliati = scelte.role === "admin" ? null : erroreDepositi(scelte.depositi);
    if (sbagliati) { toast({ title: "Depositi del roster", description: sbagliati, variant: "destructive" }); return; }
    setBusy(true);
    try {
      await apiFetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName, role: scelte.role, ruoli: scelte.ruoli, accessoDiPrima: scelte.accessoDiPrima,
          datiSanitari: scelte.datiSanitari, analisi: scelte.analisi, ...elenchiDaSalvare(scelte.depositi), fleetcareRole: scelte.fleetcareRole,
        }),
      });
      toast({ title: "Salvato" });
      onSaved();
    } catch (e: any) {
      toast({ title: "Errore", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Modifica {user.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="modifica-utente-nome">Nome completo</Label>
            <Input id="modifica-utente-nome" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <PermessiUtente scelte={scelte} onChange={setScelte} diPrima={user.accessoDiPrima ?? {}} prefisso="modifica-utente" depositi={depositi} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Salvataggio…" : "Salva"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── I permessi di un utente: ruoli aziendali, accesso di prima, capacità ─── */

/** I ruoli di un utente in una riga della tabella. */
function RuoliInBreve({ u, depositi }: { u: AdminUser; depositi: DepositoCatalogo[] }) {
  if (u.role === "admin") return <span className="text-xs text-amber-400/80">amministratore di sistema: può tutto</span>;
  const diPrima = INTERRUTTORI_DI_PRIMA.filter(i => u.accessoDiPrima?.[i] === true);
  const niente = (u.ruoli ?? []).length === 0 && diPrima.length === 0 && !u.analisi;
  return (
    <div className="flex flex-wrap gap-1 max-w-md">
      {(u.ruoli ?? []).map(r => (
        <span key={r} className="text-[11px] px-1.5 py-0.5 rounded border border-primary/40 bg-primary/10 text-primary">{NOMI_RUOLI[r] ?? r}</span>
      ))}
      {diPrima.length > 0 && (
        <span className="text-[11px] px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300"
          title="Gli interruttori di prima dei ruoli: valgono scrittura sulla loro area. Si spengono da «Modifica», dopo aver dato i ruoli.">
          accesso di prima: {diPrima.map(i => NOMI_INTERRUTTORI[i]).join(", ")}
        </span>
      )}
      {depositiInBreve(u, c => depositi.find(d => d.codice === c)?.nome ?? c).map(testo => (
        <span key={testo} className="text-[11px] px-1.5 py-0.5 rounded border border-sky-500/40 bg-sky-500/10 text-sky-300"
          title="I depositi di cui vede e di cui modifica i conducenti, nel tabellone e nell'anagrafica.">
          {testo}
        </span>
      ))}
      {u.datiSanitari && <span className="text-[11px] px-1.5 py-0.5 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300">dati sanitari</span>}
      {u.analisi && <span className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground">Analisi</span>}
      {niente && <span className="text-xs text-muted-foreground">nessun ruolo: non apre nessuna area</span>}
    </div>
  );
}

const LIVELLO_IN_PAROLE = { S: "scrive", L: "legge" } as const;

function PermessiUtente({ scelte, onChange, diPrima = {}, prefisso, depositi }: {
  scelte: Scelte;
  onChange: (s: Scelte) => void;
  /** gli interruttori di prima che l'utente ha oggi: si possono solo togliere */
  diPrima?: Partial<Record<InterruttoreDiPrima, true>>;
  prefisso: string;
  /** il catalogo dei depositi del roster, per limitare la scrittura */
  depositi: DepositoCatalogo[];
}) {
  const admin = scelte.role === "admin";
  const matrice = useContext(MatriceInVigore);
  const diritti = dirittiDelleScelte(scelte, matrice);
  const quelliDiPrima = INTERRUTTORI_DI_PRIMA.filter(i => diPrima[i] === true);
  const flotta = puo(diritti, "flotta", "L");
  const roster = puo(diritti, "roster", "L");
  /* «modifica» ha senso solo per chi il roster lo scrive; i depositi che vede, per chi i conducenti li legge */
  const scriveRoster = !admin && puo(diritti, "roster", "S");
  const leggeConducenti = !admin && (roster || puo(diritti, "personale", "L"));
  const dep = scelte.depositi;
  const cambiaDepositi = (d: DepositiScelti) => onChange({ ...scelte, depositi: d });
  /* un deposito scelto che non è più nel catalogo si mostra lo stesso: si deve poter togliere */
  const sceltiFuoriCatalogo = [...new Set([...dep.depositi, ...dep.depositiVisibili])].filter(c => !depositi.some(d => d.codice === c));
  const depositiMostrati: DepositoCatalogo[] = [
    ...depositi,
    ...sceltiFuoriCatalogo.map(c => ({ codice: c, nome: `${c} (non più nel catalogo)` })),
  ];
  const erroreDeiDepositi = erroreDepositi(dep);
  /* la stessa regola del database (users.mfa_obbligatoria): chi vede il personale o il roster */
  const verificaObbligatoria = admin || roster || puo(diritti, "personale", "L");
  const suggerito = scelte.ruoli.map(r => RUOLO_FLEETCARE_SUGGERITO[r]).find(Boolean);

  const cambiaRuolo = (r: RuoloAziendale, acceso: boolean) =>
    onChange({ ...scelte, ruoli: RUOLI.filter(x => (x === r ? acceso : scelte.ruoli.includes(x))) });
  const cambiaDiPrima = (i: InterruttoreDiPrima, acceso: boolean) => {
    const resto = { ...scelte.accessoDiPrima };
    if (acceso) resto[i] = true; else delete resto[i];
    onChange({ ...scelte, accessoDiPrima: resto });
  };

  return (
    <div className="space-y-4 border-t border-border/40 pt-3">
      <div>
        <Label htmlFor={`${prefisso}-sistema`}>Amministratore di sistema</Label>
        <select
          id={`${prefisso}-sistema`}
          className="w-full bg-background border border-border rounded-md h-9 px-2"
          value={scelte.role}
          onChange={(e) => onChange({ ...scelte, role: e.target.value === "admin" ? "admin" : "user" })}
        >
          <option value="user">no</option>
          <option value="admin">sì: gestisce utenti, azienda e integrazioni, e può tutto</option>
        </select>
      </div>

      {!admin && (
        <>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium mb-1">Ruoli aziendali</legend>
            {RUOLI.map(r => (
              <label key={r} className="flex items-start gap-2 cursor-pointer">
                <Checkbox className="mt-0.5" checked={scelte.ruoli.includes(r)} onCheckedChange={(v) => cambiaRuolo(r, v === true)} />
                <span className="text-sm leading-tight">
                  {NOMI_RUOLI[r]}
                  {/* quello che il ruolo dà adesso: si cambia in Amministrazione › Ruoli */}
                  <span className="block text-xs text-muted-foreground">{riassuntoDeiDiritti(rigaDelRuolo(matrice, r))}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {quelliDiPrima.length > 0 && (
            <fieldset className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <legend className="text-sm font-medium px-1 text-amber-300">Accesso di prima</legend>
              <p className="text-xs text-muted-foreground">
                Gli interruttori che questo utente aveva prima dei ruoli: finché restano accesi valgono come scrittura sulla loro area.
                Dagli i ruoli qui sopra, poi togli la spunta: una volta tolto non si rimette, i diritti nuovi si danno con i ruoli.
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {quelliDiPrima.map(i => (
                  <label key={i} className="flex items-center gap-2 cursor-pointer text-sm">
                    <Checkbox checked={scelte.accessoDiPrima[i] === true} onCheckedChange={(v) => cambiaDiPrima(i, v === true)} />
                    {NOMI_INTERRUTTORI[i]}
                  </label>
                ))}
              </div>
              {haAccessoDiPrima(scelte.accessoDiPrima) && (
                <Button type="button" size="sm" variant="outline" onClick={() => onChange({ ...scelte, accessoDiPrima: {} })}>
                  Spegni tutto l'accesso di prima
                </Button>
              )}
            </fieldset>
          )}

          {leggeConducenti && depositiMostrati.length > 0 && (
            <fieldset className="space-y-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
              <legend className="px-1 text-sm font-medium">Depositi del roster</legend>
              <p className="text-xs text-muted-foreground">
                Di quali depositi vede i conducenti, nel tabellone e nell'anagrafica, e di quali li può modificare.
              </p>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={`${prefisso}-vede-tutti`} className="text-sm font-normal cursor-pointer">Vede i conducenti di tutti i depositi</Label>
                <Switch id={`${prefisso}-vede-tutti`} checked={dep.vedeTutti}
                  onCheckedChange={(v) => cambiaDepositi(conInterruttore(dep, v, depositi.map(d => d.codice), scriveRoster))} />
              </div>
              {dep.vedeTutti ? (
                scriveRoster && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {dep.depositi.length === 0
                        ? "Nessun deposito scelto: modifica i conducenti di tutti."
                        : "Modifica solo i conducenti di questi depositi. Gli altri li vede, senza poterli modificare."}
                    </p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                      {depositiMostrati.map(d => (
                        <label key={d.codice} htmlFor={`${prefisso}-deposito-${d.codice}`} className="flex items-center gap-2 text-sm cursor-pointer">
                          <Checkbox id={`${prefisso}-deposito-${d.codice}`} checked={dep.depositi.includes(d.codice)}
                            onCheckedChange={(v) => cambiaDepositi(conModifica(dep, d.codice, v === true))} />
                          {d.nome}
                        </label>
                      ))}
                    </div>
                  </>
                )
              ) : (
                <div className="space-y-1.5">
                  {depositiMostrati.map(d => {
                    const valore = sceltaSul(dep, d.codice);
                    return (
                      <div key={d.codice} role="radiogroup" aria-label={d.nome} className="flex items-center justify-between gap-3">
                        <span className="text-sm">{d.nome}</span>
                        <div className="inline-flex rounded-md border border-border overflow-hidden shrink-0">
                          {SCELTE_DEPOSITO.map(([s, etichetta]) => {
                            const id = `${prefisso}-dep-${d.codice}-${s}`;
                            const accesa = valore === s;
                            return (
                              <label key={s} htmlFor={id}
                                className={`px-2.5 py-1 text-xs cursor-pointer select-none border-r border-border last:border-r-0 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-primary ${
                                  accesa
                                    ? s === "modifica" ? "bg-primary text-primary-foreground font-medium" : s === "vede" ? "bg-primary/25 text-foreground font-medium" : "bg-muted text-foreground font-medium"
                                    : "text-muted-foreground hover:bg-muted/40"}`}>
                                <input type="radio" id={id} name={`${prefisso}-dep-${d.codice}`} value={s} checked={accesa}
                                  onChange={() => cambiaDepositi(conScelta(dep, d.codice, s))} className="sr-only" />
                                {etichetta}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {!scriveRoster && (
                    <p className="text-xs text-muted-foreground">«Modifica» vale solo se il suo ruolo scrive il Roster.</p>
                  )}
                  {erroreDeiDepositi && <p role="alert" className="text-xs text-destructive">{erroreDeiDepositi}</p>}
                </div>
              )}
            </fieldset>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium">Capacità date a questo utente</p>
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm leading-tight">
                Dati sanitari
                <span className="block text-xs text-muted-foreground">
                  Vede e scrive nel roster i codici di malattia, infortunio e 104. Chi non ce l'ha legge «assenza» senza il motivo.
                  {!roster && " Serve anche poter aprire il roster."}
                </span>
              </span>
              {/* senza il roster la capacità non si può usare: il server la spegne al salvataggio */}
              <Switch checked={scelte.datiSanitari && roster} disabled={!roster} aria-label="Dati sanitari"
                onCheckedChange={(v) => onChange({ ...scelte, datiSanitari: v })} />
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm leading-tight">
                Analisi
                <span className="block text-xs text-muted-foreground">{DESCRIZIONI_AREE.analisi}. Nessun ruolo la dà.</span>
              </span>
              <Switch checked={scelte.analisi} aria-label="Analisi" onCheckedChange={(v) => onChange({ ...scelte, analisi: v })} />
            </div>
          </div>

          {flotta && (
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={`${prefisso}-fleetcare`} className="leading-tight">
                Ruolo dentro FleetCare
                {suggerito && suggerito !== scelte.fleetcareRole && (
                  <span className="block text-xs font-normal text-muted-foreground">Di solito, con questi ruoli: {FLEETCARE_ROLE_LABEL[suggerito] ?? suggerito}</span>
                )}
              </Label>
              <select
                id={`${prefisso}-fleetcare`}
                className="bg-background border border-border rounded-md h-8 px-2 text-sm"
                value={scelte.fleetcareRole}
                onChange={(e) => onChange({ ...scelte, fleetcareRole: e.target.value })}
              >
                {Object.entries(FLEETCARE_ROLE_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          )}
        </>
      )}

      <div>
        <p className="text-sm font-medium mb-1">Che cosa può fare</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-sm">
          {AREE.map(a => (
            <div key={a} className="flex items-baseline justify-between gap-2 border-b border-border/20 py-0.5" title={DESCRIZIONI_AREE[a]}>
              <span>{NOMI_AREE[a]}</span>
              <span className={diritti[a] === "S" ? "text-emerald-400 font-medium" : diritti[a] === "L" ? "text-sky-300" : "text-muted-foreground"}>
                {diritti[a] ? LIVELLO_IN_PAROLE[diritti[a]] : "—"}
              </span>
            </div>
          ))}
        </div>
        {!admin && vedeDatiSanitari({ admin, ruoli: scelte.ruoli, accessoDiPrima: scelte.accessoDiPrima, analisi: scelte.analisi, datiSanitari: scelte.datiSanitari }, matrice) && (
          <p className="text-xs text-rose-300 mt-1">Vede i codici sanitari del roster.</p>
        )}
        {verificaObbligatoria && (
          <p className="text-xs text-muted-foreground mt-1">
            Con questi diritti la verifica in due passaggi è obbligatoria: al prossimo accesso dovrà attivarla, se non l'ha già.
          </p>
        )}
      </div>
    </div>
  );
}

function ResetPasswordDialog({
  user,
  sonoIo,
  onClose,
  onDone,
}: {
  user: AdminUser;
  sonoIo: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  /* il campo è mascherato: senza la ripetizione un errore di battitura fa una password che nessuno conosce */
  const [ripetuta, setRipetuta] = useState("");
  /* un account disattivato (per esempio perché usava una password pubblicata) con la sola
   * password nuova resterebbe fuori: «Credenziali non valide», come per una password sbagliata */
  const [riattiva, setRiattiva] = useState(!user.active);
  const [busy, setBusy] = useState(false);
  const diverse = ripetuta !== "" && ripetuta !== password;

  const submit = async () => {
    if (password.length < PASSWORD_MIN) {
      toast({ title: `Password troppo corta (almeno ${PASSWORD_MIN} caratteri)`, variant: "destructive" });
      return;
    }
    if (ripetuta !== password) {
      toast({ title: "Le due password non coincidono", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(!user.active && riattiva ? { password, active: true } : { password }),
      });
      toast({
        title: !user.active && riattiva ? "Password provvisoria impostata e account riattivato" : "Password provvisoria impostata",
        description: `Al primo accesso ${user.email} dovrà sceglierne una sua.`,
      });
      onDone();
    } catch (e: any) {
      toast({ title: "Errore", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password — {user.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            È una password provvisoria: al primo accesso Cerbero chiede di cambiarla. Le sessioni aperte di questo account si chiudono.
          </p>
          {sonoIo && (
            <p className="text-sm text-amber-400">
              È il tuo account: dopo il salvataggio esci e rientri con questa password. Per cambiarla senza uscire usa «Sicurezza dell'account».
            </p>
          )}
          <div>
            <Label htmlFor="reset-password">Nuova password</Label>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              aria-describedby="reset-password-regola"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <p id="reset-password-regola" className="text-xs text-muted-foreground mt-1">
              Almeno {PASSWORD_MIN} caratteri. Meglio una frase di più parole; niente nome, email o password comuni.
            </p>
          </div>
          <div>
            <Label htmlFor="reset-password-ripeti">Ripeti la password</Label>
            <Input
              id="reset-password-ripeti"
              type="password"
              autoComplete="new-password"
              aria-invalid={diverse}
              aria-describedby={diverse ? "reset-password-diverse" : undefined}
              value={ripetuta}
              onChange={(e) => setRipetuta(e.target.value)}
            />
            {diverse && (
              <p id="reset-password-diverse" role="alert" className="text-xs text-red-400 mt-1">
                Le due password non coincidono.
              </p>
            )}
          </div>
          {!user.active && (
            <div className="flex items-start gap-2">
              <Checkbox id="reset-password-riattiva" checked={riattiva} onCheckedChange={(v) => setRiattiva(v === true)} className="mt-0.5" />
              <Label htmlFor="reset-password-riattiva" className="font-normal leading-snug">
                Riattiva anche l'account. Ora è disattivato: con la sola password nuova non entra.
              </Label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Salvataggio…" : "Imposta"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Il registro degli accessi: chi, quando, da dove, com'è andata (12 mesi). */
function RegistroAccessi() {
  const [voci, setVoci] = useState<VoceAccesso[] | null>(null);
  const [aperto, setAperto] = useState(false);
  const carica = useCallback(async () => {
    try { setVoci((await apiFetch<{ accessi: VoceAccesso[] }>("/api/admin/accessi?limite=500")).accessi); }
    catch { setVoci([]); }
  }, []);
  useEffect(() => { if (aperto && !voci) void carica(); }, [aperto, voci, carica]);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Registro degli accessi</CardTitle>
        <div className="flex gap-2">
          {aperto && <Button size="sm" variant="ghost" onClick={() => void carica()}>Aggiorna</Button>}
          <Button size="sm" variant="outline" onClick={() => setAperto(!aperto)} aria-expanded={aperto}>{aperto ? "Nascondi" : "Mostra"}</Button>
        </div>
      </CardHeader>
      {aperto && (
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">Ultimi 500 eventi. Si conservano 12 mesi.</p>
          {!voci ? <p className="text-sm text-muted-foreground">Caricamento…</p> : (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left text-muted-foreground border-b border-border/40">
                    <th className="py-1.5 pr-3">Quando</th><th className="py-1.5 pr-3">Utente</th><th className="py-1.5 pr-3">Che cosa</th><th className="py-1.5 pr-3">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {voci.map(v => (
                    <tr key={v.id} className="border-b border-border/10">
                      <td className="py-1 pr-3 whitespace-nowrap tabular-nums">{new Date(v.ts).toLocaleString("it-IT")}</td>
                      <td className="py-1 pr-3 font-mono">{v.email ?? "—"}</td>
                      <td className={`py-1 pr-3 ${/errat|sconosciut|bloccat|pubblicat|illeggibil/.test(v.esito) ? "text-amber-400" : ""}`}>{esitoLeggibile(v.esito)}</td>
                      <td className="py-1 pr-3 font-mono text-muted-foreground" title={v.userAgent ?? ""}>{v.ip ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
