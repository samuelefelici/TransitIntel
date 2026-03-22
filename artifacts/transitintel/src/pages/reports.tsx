import React from "react";
import { useGetUnderservedAreas } from "@workspace/api-client-react";
import { Download, AlertTriangle, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

export default function Reports() {
  const { data: underserved } = useGetUnderservedAreas({ minScore: 0.6 });
  const { toast } = useToast();

  const handleExport = () => {
    toast({
      title: "Esportazione avviata",
      description: "Il report di analisi domanda è in fase di generazione.",
    });
  };

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display font-bold text-foreground">Analisi Domanda</h1>
          <p className="text-muted-foreground mt-2">Individua le criticità nella rete di trasporto.</p>
        </div>
        <Button onClick={handleExport} className="gap-2 shrink-0">
          <Download className="w-4 h-4" /> Esporta Report
        </Button>
      </div>

      <Card className="bg-card/50 backdrop-blur-sm border-border/50 border-destructive/20 shadow-lg shadow-destructive/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="w-5 h-5" /> 
            Aree ad Alta Domanda Scoperte
          </CardTitle>
          <CardDescription>
            Zone con alta densità abitativa/POI ma senza fermate entro 400 m.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border/50 overflow-hidden bg-background/30">
            <Table>
              <TableHeader className="bg-background/80">
                <TableRow>
                  <TableHead>Posizione</TableHead>
                  <TableHead>Punteggio Domanda</TableHead>
                  <TableHead>Fermata più vicina</TableHead>
                  <TableHead>Pop. coinvolta</TableHead>
                  <TableHead>Attrattori principali</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!underserved?.data ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-8">Analisi copertura in corso…</TableCell></TableRow>
                ) : underserved.data.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-8 text-green-500 font-medium">Nessuna area critica scoperta. Copertura eccellente!</TableCell></TableRow>
                ) : (
                  underserved.data.map((area, idx) => (
                    <TableRow key={area.cellId || idx} className="hover:bg-white/5">
                      <TableCell className="font-mono text-xs">
                        {area.lat.toFixed(4)}, {area.lng.toFixed(4)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-full bg-secondary h-2 rounded-full max-w-[100px] overflow-hidden">
                            <div 
                              className="bg-destructive h-full rounded-full" 
                              style={{ width: `${area.score * 100}%` }}
                            />
                          </div>
                          <span className="text-xs font-bold">{(area.score * 100).toFixed(0)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-destructive font-medium">
                          {(area.nearestStopDistanceMeters / 1000).toFixed(1)} km
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 font-medium">
                          <Users className="w-3.5 h-3.5 text-muted-foreground" />
                          {area.populationAffected?.toLocaleString() || '--'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {area.topPoiCategories?.slice(0,2).map(c => (
                            <span key={c} className="text-[10px] uppercase tracking-wider bg-white/10 px-1.5 py-0.5 rounded text-muted-foreground">
                              {c}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
