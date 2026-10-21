/**
 * Parametri di esercizio (Amministrazione, solo admin): i valori dell'azienda
 * che i motori dei turni leggono quando chi lancia un calcolo non ne indica
 * uno suo. Per ora le autovetture aziendali; prima stavano nella vecchia
 * pagina «Gestione Cluster» di /optimization.
 */
import { useEffect, useState } from "react";
import { Car, Save, Settings2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const MAX_AUTOVETTURE = 50;

export default function AdminParametriPage() {
  const { toast } = useToast();
  const [salvato, setSalvato] = useState<number | null>(null);
  const [valore, setValore] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<{ companyCars: number }>("/api/settings/company-cars")
      .then(r => { setSalvato(r.companyCars); setValore(String(r.companyCars)); })
      .catch((e: any) => toast({ title: "Parametri non letti", description: e?.message, variant: "destructive" }));
  }, [toast]);

  const numero = Number(valore);
  const valido = valore.trim() !== "" && Number.isInteger(numero) && numero >= 0 && numero <= MAX_AUTOVETTURE;

  const salva = async () => {
    if (!valido) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ companyCars: number }>("/api/settings/company-cars", {
        method: "PUT", body: JSON.stringify({ companyCars: numero }),
      });
      setSalvato(r.companyCars ?? numero);
      toast({ title: "Autovetture aziendali salvate", description: `I prossimi calcoli dei turni ne useranno ${r.companyCars ?? numero}.` });
    } catch (e: any) {
      toast({ title: "Non salvato", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings2 className="w-6 h-6 text-primary" aria-hidden /> Parametri di esercizio
        </h1>
        <p className="text-sm text-muted-foreground">
          I valori dell'azienda che i calcoli dei turni usano quando chi li lancia non ne indica uno suo.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Car className="w-4 h-4 text-primary" aria-hidden /> Autovetture aziendali
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Quante auto aziendali ci sono per portare i conducenti ai cambi in linea. I turni guida non ne usano mai di più.
          </p>
          <div className="flex items-end gap-3">
            <div>
              <Label htmlFor="autovetture">Numero</Label>
              <Input
                id="autovetture"
                type="number"
                min={0}
                max={MAX_AUTOVETTURE}
                value={valore}
                onChange={e => setValore(e.target.value)}
                aria-invalid={valore !== "" && !valido}
                aria-describedby="autovetture-regola"
                className="w-28"
              />
            </div>
            <Button onClick={() => void salva()} disabled={busy || !valido || numero === salvato}>
              <Save className="w-4 h-4 mr-1.5" aria-hidden /> {busy ? "Salvataggio…" : "Salva"}
            </Button>
          </div>
          <p id="autovetture-regola" className="text-xs text-muted-foreground">
            Da 0 a {MAX_AUTOVETTURE}. {salvato !== null ? `Oggi: ${salvato}.` : ""}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
