import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth, type Permission } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  role: "admin" | "user";
  permissions: Record<Permission, boolean>;
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
};
const esitoLeggibile = (e: string) => {
  const m = /^admin:([a-z_]+) \((.*)\)$/.exec(e);
  if (m) {
    const azione = ({ password_provvisoria: "password provvisoria", verifica_tolta: "verifica tolta", sbloccato: "sbloccato", disattivato: "disattivato", riattivato: "riattivato" } as Record<string, string>)[m[1]!] ?? m[1];
    return `${azione}, dall'admin ${m[2]}`;
  }
  return ESITO_LABEL[e] ?? e;
};

const PERM_LABEL: Record<Permission, string> = {
  analytics: "Analytics (Traffico/Territorio/Rete)",
  fares: "Bigliettazione (Fares Engine)",
  scheduling: "Scheduling (Crea Servizio + Ottimizzazione)",
  network: "Network Engine (PlannerStudio + Crea Servizio)",
  centrale: "Centrale Operativa (Mappa live + AVM)",
  personale: "Personale (anagrafica completa: contatti, paghe, ferie, visite)",
  roster: "Roster (tabellone, assenze, rotazioni; vede malattia, infortunio, 104)",
  fleetcare: "FleetCare (Gestione Flotta e Manutenzione)",
};

/** Colonne-interruttore della tabella utenti, nell'ordine in cui compaiono.
 *  FleetCare ha una colonna sua perché porta anche il ruolo. */
const PERM_COLONNE: Array<{ perm: Permission; intestazione: string }> = [
  { perm: "analytics", intestazione: "Analytics" },
  { perm: "fares", intestazione: "Fares" },
  { perm: "scheduling", intestazione: "Scheduling" },
  { perm: "network", intestazione: "Network" },
  { perm: "centrale", intestazione: "Centrale Op." },
  { perm: "personale", intestazione: "Personale" },
  { perm: "roster", intestazione: "Roster" },
];

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

  const handleTogglePermission = async (u: AdminUser, p: Permission) => {
    const next = { ...u.permissions, [p]: !u.permissions?.[p] };
    try {
      await apiFetch(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: next }),
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
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-primary" />
            Gestione Utenti
          </h1>
          <p className="text-sm text-muted-foreground">
            Crea utenti, assegna permessi, resetta password.
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
                    <th className="py-2 pr-4">Ruolo</th>
                    <th className="py-2 pr-4">Attivo</th>
                    {PERM_COLONNE.map((c) => (
                      <th key={c.perm} className="py-2 pr-4" title={PERM_LABEL[c.perm]}>{c.intestazione}</th>
                    ))}
                    <th className="py-2 pr-4" title={PERM_LABEL.fleetcare}>FleetCare</th>
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
                            <span className="text-muted-foreground">user</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <Switch
                            checked={u.active}
                            disabled={u.id === me?.id}
                            onCheckedChange={() => handleToggleActive(u)}
                          />
                        </td>
                        {PERM_COLONNE.map(({ perm: p }) => (
                          <td key={p} className="py-2 pr-4">
                            <Switch
                              checked={isAdminRow ? true : !!u.permissions?.[p]}
                              disabled={isAdminRow}
                              aria-label={PERM_LABEL[p]}
                              onCheckedChange={() => handleTogglePermission(u, p)}
                            />
                          </td>
                        ))}
                        {/* FleetCare: abilitazione + ruolo dentro il modulo.
                            Gli admin sono sempre abilitati (come fleet_admin). */}
                        <td className="py-2 pr-4">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={isAdminRow ? true : !!u.permissions?.fleetcare}
                              disabled={isAdminRow}
                              onCheckedChange={() => handleTogglePermission(u, "fleetcare")}
                            />
                            {isAdminRow ? (
                              <span className="text-xs text-amber-400/80">Admin Flotta</span>
                            ) : u.permissions?.fleetcare ? (
                              <select
                                className="bg-background border border-border rounded-md h-7 px-1 text-xs"
                                value={u.fleetcareRole || "driver"}
                                onChange={(e) => handleFleetcareRole(u, e.target.value)}
                                title="Ruolo dell'utente dentro FleetCare"
                              >
                                {Object.entries(FLEETCARE_ROLE_LABEL).map(([v, l]) => (
                                  <option key={v} value={v}>{l}</option>
                                ))}
                              </select>
                            ) : null}
                          </div>
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
          onClose={() => setResetPwdFor(null)}
          onDone={() => setResetPwdFor(null)}
        />
      )}
    </div>
  );
}

/* ─── Dialogs ─── */

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [perms, setPerms] = useState<Record<Permission, boolean>>({
    analytics: true,
    fares: true,
    scheduling: true,
    network: true,
    // I moduli (Centrale Operativa, FleetCare) li abilita esplicitamente l'admin
    centrale: false,
    personale: false,
    roster: false,
    fleetcare: false,
  });
  const [fleetcareRole, setFleetcareRole] = useState("driver");
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
    setBusy(true);
    try {
      await apiFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, fullName, password, role, permissions: perms, fleetcareRole }),
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuovo utente</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label>Nome completo</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
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
          <div>
            <Label>Ruolo</Label>
            <select
              className="w-full bg-background border border-border rounded-md h-9 px-2"
              value={role}
              onChange={(e) => setRole(e.target.value as any)}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div className="space-y-2 border-t border-border/40 pt-3">
            <p className="text-sm font-medium">Permessi</p>
            {(Object.keys(PERM_LABEL) as Permission[]).map((p) => (
              <div key={p} className="flex items-center justify-between">
                <span className="text-sm">{PERM_LABEL[p]}</span>
                <Switch
                  checked={role === "admin" ? true : perms[p]}
                  disabled={role === "admin"}
                  onCheckedChange={(v) => setPerms((prev) => ({ ...prev, [p]: v }))}
                />
              </div>
            ))}
            {/* Ruolo dentro FleetCare (solo se abilitato; gli admin sono sempre Admin Flotta) */}
            {role !== "admin" && perms.fleetcare && (
              <div className="flex items-center justify-between pl-4">
                <span className="text-sm text-muted-foreground">Ruolo in FleetCare</span>
                <select
                  className="bg-background border border-border rounded-md h-8 px-2 text-sm"
                  value={fleetcareRole}
                  onChange={(e) => setFleetcareRole(e.target.value)}
                >
                  {Object.entries(FLEETCARE_ROLE_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
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
  onClose,
  onSaved,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [fullName, setFullName] = useState(user.fullName || "");
  const [role, setRole] = useState<"admin" | "user">(user.role);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await apiFetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, role }),
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Modifica {user.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Nome completo</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div>
            <Label>Ruolo</Label>
            <select
              className="w-full bg-background border border-border rounded-md h-9 px-2"
              value={role}
              onChange={(e) => setRole(e.target.value as any)}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Salvataggio…" : "Salva"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password.length < PASSWORD_MIN) {
      toast({ title: `Password troppo corta (almeno ${PASSWORD_MIN} caratteri)`, variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      toast({ title: "Password aggiornata" });
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
