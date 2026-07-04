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
}

const PERM_LABEL: Record<Permission, string> = {
  analytics: "Analytics (Traffico/Territorio/Rete)",
  fares: "Bigliettazione (Fares Engine)",
  scheduling: "Scheduling (Crea Servizio + Ottimizzazione)",
  network: "Network Engine (PlannerStudio + Crea Servizio)",
  fleetcare: "FleetCare (Gestione Flotta e Manutenzione)",
};

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
                    <th className="py-2 pr-4">Analytics</th>
                    <th className="py-2 pr-4">Fares</th>
                    <th className="py-2 pr-4">Scheduling</th>
                    <th className="py-2 pr-4">Network</th>
                    <th className="py-2 pr-4">FleetCare</th>
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
                        {(["analytics", "fares", "scheduling", "network"] as Permission[]).map((p) => (
                          <td key={p} className="py-2 pr-4">
                            <Switch
                              checked={isAdminRow ? true : !!u.permissions?.[p]}
                              disabled={isAdminRow}
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
    // FleetCare va abilitato esplicitamente dall'admin
    fleetcare: false,
  });
  const [fleetcareRole, setFleetcareRole] = useState("driver");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email || !password) {
      toast({ title: "Email e password obbligatori", variant: "destructive" });
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
            <Label>Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
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
    if (password.length < 6) {
      toast({ title: "Password troppo corta (min 6)", variant: "destructive" });
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
            <Label>Nuova password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
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
