/**
 * La biblioteca di Argos: che cosa sa (documenti, passaggi, concetti), come ci
 * arriva (il caricamento, fase per fase: conversione, chunking, embedding,
 * scrittura) e come è stato tagliato ogni documento (la striscia dei chunk,
 * lunga quanto il testo di ciascuno).
 *
 * Caricare, rinominare, spostare ed eliminare è solo dell'amministratore (lo
 * controlla anche il server); gli altri vedono e leggono.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen, Brain, Check, FileText, Layers, Loader2, Network, Pencil, RotateCcw, Search, Trash2, UploadCloud, X,
} from "lucide-react";
import {
  biblioteca, carica, FASI_CARICAMENTO, faseCaricamento, FORMATI_ARGOS, quandoFa, token,
  type Caricamento as Job, type ChunkDocumento, type DocumentoBiblioteca, type OpzioniCaricamento, type StatoCostruzione,
} from "@/lib/argos-console";
import { elencoTinte, tintaCategoria } from "@/lib/argos-grafo";
import { Caricamento, Numero, Pill, Problema, Riquadro, Vuoto, type Tinta } from "./comuni";

/** Quello che Argos legge: PDF, testi, EPUB e ora anche Office, LibreOffice, CSV, HTML, JSON e immagini. */
const ESTENSIONI: readonly string[] = FORMATI_ARGOS;
const MAX_MB = 100;
const CHIAVE = ["argos-console", "biblioteca"] as const;

function estensione(nome: string): string {
  const i = nome.lastIndexOf(".");
  return i >= 0 ? nome.slice(i).toLowerCase() : "";
}
function peso(byte: number): string {
  if (byte < 1024 * 1024) return `${Math.max(1, Math.round(byte / 1024))} KB`;
  return `${(byte / 1024 / 1024).toFixed(1)} MB`;
}

const TINTA_JOB: Record<Job["status"], Tinta> = { queued: "neutro", running: "info", done: "ok", error: "errore" };
const NOME_JOB: Record<Job["status"], string> = { queued: "In coda", running: "In lavorazione", done: "Pronto", error: "Errore" };

function PuntoCategoria({ categoria, categorie }: { categoria: string | null; categorie: string[] }) {
  return <span className="argos-cat-punto" data-cat={tintaCategoria(categoria, categorie)} aria-hidden />;
}

// ─── il caricamento ─────────────────────────────────────────────────────────
interface FileInCoda { id: string; file: File; stato: "pronto" | "invio" | "inviato" | "errore"; frazione: number; errore?: string }

function Caricatore({ categorie, dopo }: { categorie: string[]; dopo: () => void }) {
  const [files, setFiles] = useState<FileInCoda[]>([]);
  const [sopra, setSopra] = useState(false);
  const [opz, setOpz] = useState<OpzioniCaricamento>({ parser: "auto" });
  const [invio, setInvio] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const aggiungi = useCallback((lista: FileList | File[]) => {
    const nuovi: FileInCoda[] = [];
    for (const f of Array.from(lista)) {
      const ok = ESTENSIONI.includes(estensione(f.name));
      const grande = f.size > MAX_MB * 1024 * 1024;
      nuovi.push({
        id: `${f.name}-${f.size}-${f.lastModified}`, file: f,
        stato: ok && !grande ? "pronto" : "errore", frazione: 0,
        errore: !ok ? "formato non supportato" : grande ? `oltre ${MAX_MB} MB` : undefined,
      });
    }
    setFiles(v => [...v.filter(x => x.stato !== "inviato"), ...nuovi.filter(n => !v.some(x => x.id === n.id))]);
  }, []);

  const lascia = (e: DragEvent) => { e.preventDefault(); setSopra(false); if (e.dataTransfer.files?.length) aggiungi(e.dataTransfer.files); };
  const pronti = files.filter(f => f.stato === "pronto");
  const unoSolo = pronti.length === 1;
  const unPdf = unoSolo && estensione(pronti[0]!.file.name) === ".pdf";

  async function invia() {
    setInvio(true);
    for (const f of pronti) {
      setFiles(v => v.map(x => (x.id === f.id ? { ...x, stato: "invio", frazione: 0 } : x)));
      try {
        await carica(f.file, {
          ...opz,
          title: unoSolo ? opz.title : undefined,
          page_from: unPdf ? opz.page_from : undefined,
          page_to: unPdf ? opz.page_to : undefined,
        }, fr => setFiles(v => v.map(x => (x.id === f.id ? { ...x, frazione: fr } : x))));
        setFiles(v => v.map(x => (x.id === f.id ? { ...x, stato: "inviato", frazione: 1 } : x)));
        dopo();
      } catch (e) {
        setFiles(v => v.map(x => (x.id === f.id ? { ...x, stato: "errore", errore: e instanceof Error ? e.message : String(e) } : x)));
      }
    }
    setInvio(false);
    setOpz(o => ({ ...o, title: undefined, page_from: undefined, page_to: undefined }));
  }

  const campo = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="space-y-3">
      <div
        onDragOver={e => { e.preventDefault(); setSopra(true); }} onDragLeave={() => setSopra(false)} onDrop={lascia}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${sopra ? "border-primary bg-primary/5" : "border-border"}`}>
        <UploadCloud className={`h-8 w-8 ${sopra ? "text-primary" : "text-muted-foreground"}`} aria-hidden />
        <div className="text-sm font-medium">Trascina qui i documenti</div>
        <div className="text-[11px] text-muted-foreground">PDF, Word, Excel, PowerPoint, LibreOffice, CSV, Markdown, testo, EPUB, immagini · fino a {MAX_MB} MB l'uno</div>
        <button type="button" onClick={() => input.current?.click()}
          className="mt-1 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Scegli i file
        </button>
        <input ref={input} type="file" multiple accept={ESTENSIONI.join(",")} className="sr-only" tabIndex={-1}
          onChange={e => { if (e.target.files) aggiungi(e.target.files); e.target.value = ""; }} />
      </div>

      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map(f => (
            <li key={f.id} className="rounded-lg border border-border px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium" title={f.file.name}>{f.file.name}</span>
                <span className="tabular-nums text-muted-foreground">{peso(f.file.size)}</span>
                {f.stato === "inviato" && <Pill tinta="ok"><Check className="h-3 w-3" aria-hidden />In coda su Argos</Pill>}
                {f.stato === "errore" && <Pill tinta="errore">{f.errore}</Pill>}
                {f.stato === "invio" && <span className="tabular-nums text-muted-foreground">{Math.round(f.frazione * 100)}%</span>}
                {(f.stato === "pronto" || f.stato === "errore") && !invio && (
                  <button type="button" onClick={() => setFiles(v => v.filter(x => x.id !== f.id))} aria-label={`Togli ${f.file.name}`}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                )}
              </div>
              {f.stato === "invio" && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" data-tinta="info">
                  <div className="argos-barra h-full transition-[width]" style={{ width: `${f.frazione * 100}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {pronti.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-[11px] font-medium text-muted-foreground">Categoria
            <input list="argos-categorie" className={`${campo} mt-1`} placeholder="es. Normativa" maxLength={120}
              value={opz.category ?? ""} onChange={e => setOpz(o => ({ ...o, category: e.target.value || undefined }))} />
            <datalist id="argos-categorie">{categorie.map(c => <option key={c} value={c} />)}</datalist>
          </label>
          <label className="text-[11px] font-medium text-muted-foreground">Lettura del testo
            <select className={`${campo} mt-1`} value={opz.parser} onChange={e => setOpz(o => ({ ...o, parser: e.target.value as OpzioniCaricamento["parser"] }))}>
              <option value="auto">Automatica</option>
              <option value="mathpix">PDF con formule e tabelle (Mathpix)</option>
              <option value="text">Solo testo</option>
              <option value="markdown">Markdown</option>
            </select>
          </label>
          {unoSolo && (
            <label className="text-[11px] font-medium text-muted-foreground sm:col-span-2">Titolo (facoltativo)
              <input className={`${campo} mt-1`} maxLength={300} placeholder={pronti[0]!.file.name.replace(/\.[^.]+$/, "")}
                value={opz.title ?? ""} onChange={e => setOpz(o => ({ ...o, title: e.target.value || undefined }))} />
            </label>
          )}
          {unPdf && (
            <div className="grid grid-cols-2 gap-2 sm:col-span-2">
              <label className="text-[11px] font-medium text-muted-foreground">Dalla pagina
                <input type="number" min={1} max={99999} className={`${campo} mt-1`} value={opz.page_from ?? ""}
                  onChange={e => setOpz(o => ({ ...o, page_from: e.target.value ? Number(e.target.value) : undefined }))} />
              </label>
              <label className="text-[11px] font-medium text-muted-foreground">Alla pagina
                <input type="number" min={1} max={99999} className={`${campo} mt-1`} value={opz.page_to ?? ""}
                  onChange={e => setOpz(o => ({ ...o, page_to: e.target.value ? Number(e.target.value) : undefined }))} />
              </label>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <input type="checkbox" checked={!!opz.replace} onChange={e => setOpz(o => ({ ...o, replace: e.target.checked }))} />
            Se c'è già un documento con lo stesso titolo, sostituiscilo
          </label>
          <button type="button" disabled={invio} onClick={invia}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60 sm:col-span-2">
            {invio ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <UploadCloud className="h-3.5 w-3.5" aria-hidden />}
            {invio ? "Invio in corso…" : `Carica ${pronti.length === 1 ? "il file" : `${pronti.length} file`}`}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── la catena di montaggio ─────────────────────────────────────────────────
function Fasi({ job }: { job: Job }) {
  const attuale = faseCaricamento(job);
  const errore = job.status === "error";
  return (
    <ol className="flex items-center" aria-label={`Fase: ${FASI_CARICAMENTO[attuale]}`}>
      {FASI_CARICAMENTO.map((f, i) => {
        const fatta = i < attuale || job.status === "done";
        const ora = i === attuale && job.status !== "done";
        const tinta: Tinta = errore && ora ? "errore" : fatta ? "ok" : ora ? "info" : "neutro";
        return (
          <li key={f} className="flex flex-1 items-center last:flex-none" data-tinta={tinta}>
            <span title={f} className={`relative grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 text-[9px] font-bold ${fatta || ora ? "argos-tinta" : "text-muted-foreground"}`}
              style={{ borderColor: fatta || ora ? "hsl(var(--tinta))" : "hsl(var(--border))", background: fatta ? "hsl(var(--tinta) / 0.15)" : undefined }}>
              {fatta ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
              {ora && !errore && <span className="absolute inset-0 animate-ping rounded-full border border-current opacity-40" aria-hidden />}
            </span>
            {i < FASI_CARICAMENTO.length - 1 && (
              <span className="mx-0.5 h-0.5 flex-1 rounded-full" style={{ background: i < attuale || job.status === "done" ? "hsl(var(--argos-ok))" : "hsl(var(--border))" }} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function RigaJob({ job, admin, riprova }: { job: Job; admin: boolean; riprova: (id: number) => void }) {
  const fase = FASI_CARICAMENTO[faseCaricamento(job)];
  const embedding = job.status === "running" && (job.stage ?? "").startsWith("embedding");
  return (
    <li className="rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" title={job.title ?? job.filename ?? ""}>{job.title || job.filename || `Caricamento ${job.id}`}</div>
          <div className="text-[11px] text-muted-foreground">
            {job.category ? `${job.category} · ` : ""}{quandoFa(job.updated_at)}
            {job.status === "done" && job.total_chunks ? ` · ${job.total_chunks} passaggi` : ""}
          </div>
        </div>
        <Pill tinta={TINTA_JOB[job.status]}>
          {job.status === "running" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}{NOME_JOB[job.status]}
        </Pill>
      </div>
      <div className="mt-2"><Fasi job={job} /></div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{fase.charAt(0).toUpperCase() + fase.slice(1)}{embedding ? ` · ${job.progress}% dei passaggi` : ""}</span>
        {job.status === "error" && admin && (
          <button type="button" onClick={() => riprova(job.id)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-muted">
            <RotateCcw className="h-3 w-3" aria-hidden />Riprova
          </button>
        )}
      </div>
      {embedding && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" data-tinta="info">
          <div className="argos-barra h-full transition-[width] duration-700" style={{ width: `${job.progress}%` }} />
        </div>
      )}
      {job.error && <div className="mt-1.5 rounded bg-muted px-2 py-1 text-[11px]" title={job.error}>{job.error.slice(0, 240)}</div>}
    </li>
  );
}

// ─── il cervello ────────────────────────────────────────────────────────────
function StatoLavoro({ s, nome }: { s: StatoCostruzione | undefined; nome: string }) {
  if (!s) return null;
  const tinta: Tinta = s.state === "running" ? "info" : s.state === "error" ? "errore" : s.state === "done" ? "ok" : "neutro";
  const testo = s.state === "running" ? `${nome}: in corso${s.phase ? ` (${String(s.phase)})` : ""}${typeof s.done === "number" && typeof s.total === "number" && s.total ? ` ${s.done}/${s.total}` : ""}`
    : s.state === "error" ? `${nome}: errore` : s.state === "done" ? `${nome}: aggiornato` : `${nome}: fermo`;
  return <Pill tinta={tinta} title={s.error ?? undefined}>{s.state === "running" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}{testo}</Pill>;
}

// ─── dentro un documento ────────────────────────────────────────────────────
function Striscia({ chunks, scelto, scegli }: { chunks: ChunkDocumento[]; scelto: number | null; scegli: (i: number) => void }) {
  const totale = chunks.reduce((s, c) => s + Math.max(1, c.tokens ?? c.content.length / 4), 0) || 1;
  // le sezioni cambiano tinta (a turno su due toni), così si vede dove il documento va a capo
  let sezione: string | null = null, turno = 0;
  return (
    <div className="flex h-9 w-full gap-[2px] overflow-hidden rounded-md" role="list" aria-label="I passaggi del documento, lunghi quanto il loro testo">
      {chunks.map(c => {
        if (c.section !== sezione) { sezione = c.section; turno = 1 - turno; }
        const w = (Math.max(1, c.tokens ?? c.content.length / 4) / totale) * 100;
        const attivo = scelto === c.index;
        return (
          <button key={c.index} type="button" role="listitem" onClick={() => scegli(c.index)}
            title={`Passaggio ${c.index + 1}${c.section ? ` · ${c.section}` : ""} · ${c.tokens ?? "?"} token`}
            aria-label={`Passaggio ${c.index + 1}`} aria-pressed={attivo}
            data-tinta={attivo ? "memoria" : "info"}
            className="h-full min-w-[3px] transition-[filter,transform] hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ width: `${w}%`, background: `hsl(var(--tinta) / ${attivo ? 1 : turno ? 0.55 : 0.32})`, transform: attivo ? "scaleY(1.08)" : undefined }} />
        );
      })}
    </div>
  );
}

function Documento({ doc, categorie, admin, chiudi, apriInMappa }: {
  doc: DocumentoBiblioteca; categorie: string[]; admin: boolean; chiudi: () => void; apriInMappa?: (id: number) => void;
}) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: [...CHIAVE, "documento", doc.id], queryFn: () => biblioteca.documento(doc.id) });
  const [scelto, setScelto] = useState<number | null>(null);
  const [titolo, setTitolo] = useState<string | null>(null);
  const [conferma, setConferma] = useState(false);
  const aggiorna = () => { void qc.invalidateQueries({ queryKey: CHIAVE }); };
  const rinomina = useMutation({ mutationFn: (t: string) => biblioteca.rinomina(doc.id, t), onSuccess: () => { setTitolo(null); aggiorna(); } });
  const sposta = useMutation({ mutationFn: (c: string | null) => biblioteca.categoria(doc.id, c), onSuccess: aggiorna });
  const elimina = useMutation({ mutationFn: () => biblioteca.elimina(doc.id), onSuccess: () => { chiudi(); aggiorna(); } });
  const chunks = d.data?.chunks ?? [];
  const attivo = chunks.find(c => c.index === scelto) ?? chunks[0];
  const tokenTot = chunks.reduce((s, c) => s + (c.tokens ?? 0), 0);
  const sezioni = new Set(chunks.map(c => c.section).filter(Boolean)).size;
  const errore = rinomina.error ?? sposta.error ?? elimina.error;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {titolo !== null ? (
            <form className="flex gap-1.5" onSubmit={e => { e.preventDefault(); if (titolo.trim()) rinomina.mutate(titolo.trim()); }}>
              <input autoFocus value={titolo} maxLength={300} onChange={e => setTitolo(e.target.value)} aria-label="Nuovo titolo"
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm" />
              <button type="submit" className="rounded-md bg-primary px-2 text-xs font-semibold text-primary-foreground">Salva</button>
              <button type="button" onClick={() => setTitolo(null)} className="rounded-md border border-border px-2 text-xs">Annulla</button>
            </form>
          ) : (
            <h3 className="flex items-center gap-2 text-base font-semibold leading-tight">
              <PuntoCategoria categoria={doc.category} categorie={categorie} />
              <span className="min-w-0 break-words">{doc.title}</span>
              {admin && <button type="button" onClick={() => setTitolo(doc.title)} aria-label="Rinomina" className="rounded p-1 text-muted-foreground hover:bg-muted"><Pencil className="h-3.5 w-3.5" /></button>}
            </h3>
          )}
          <div className="mt-0.5 text-[11px] text-muted-foreground">{doc.category ?? "Senza categoria"} · caricato {quandoFa(doc.created_at)}</div>
        </div>
        <button type="button" onClick={chiudi} aria-label="Chiudi il documento" className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-muted/60 px-2 py-1.5"><div className="text-lg font-bold tabular-nums">{d.data?.total_chunks ?? doc.chunks}</div><div className="text-[10px] text-muted-foreground">passaggi</div></div>
        <div className="rounded-lg bg-muted/60 px-2 py-1.5"><div className="text-lg font-bold tabular-nums">{sezioni || "—"}</div><div className="text-[10px] text-muted-foreground">sezioni{chunks.length < (d.data?.total_chunks ?? 0) ? " (nei primi)" : ""}</div></div>
        <div className="rounded-lg bg-muted/60 px-2 py-1.5"><div className="text-lg font-bold tabular-nums">{tokenTot ? token(Math.round(tokenTot / Math.max(1, chunks.length))) : "—"}</div><div className="text-[10px] text-muted-foreground">token per passaggio</div></div>
      </div>

      {d.isLoading ? <Caricamento testo="Apro il documento…" /> : d.error ? <Problema errore={d.error} /> : chunks.length ? (
        <>
          <div>
            <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
              <span>Come è stato tagliato</span>
              <span>{chunks.length < (d.data?.total_chunks ?? 0) ? `primi ${chunks.length} di ${d.data?.total_chunks}` : `${chunks.length} passaggi`}</span>
            </div>
            <Striscia chunks={chunks} scelto={attivo?.index ?? null} scegli={setScelto} />
          </div>
          {attivo && (
            <article className="rounded-lg border border-border bg-background/60 p-3">
              <header className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <Pill tinta="memoria">Passaggio {attivo.index + 1}</Pill>
                {attivo.section && <span className="truncate font-medium text-foreground" title={attivo.section}>{attivo.section}</span>}
                <span className="ml-auto tabular-nums">{attivo.tokens ?? "?"} token</span>
              </header>
              <p className="max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-relaxed">{attivo.content}</p>
              <div className="mt-2 flex justify-between">
                <button type="button" disabled={attivo.index === chunks[0]!.index} onClick={() => setScelto(attivo.index - 1)} className="rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-40">← Precedente</button>
                <button type="button" disabled={attivo.index === chunks[chunks.length - 1]!.index} onClick={() => setScelto(attivo.index + 1)} className="rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-40">Successivo →</button>
              </div>
            </article>
          )}
        </>
      ) : <Vuoto>Nessun passaggio per questo documento.</Vuoto>}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {apriInMappa && (
          <button type="button" onClick={() => apriInMappa(doc.id)} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted">
            <Network className="h-3.5 w-3.5" aria-hidden />Vedi i legami nella mappa
          </button>
        )}
        {admin && (
          <>
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">Categoria
              <select value={doc.category ?? ""} onChange={e => sposta.mutate(e.target.value || null)} disabled={sposta.isPending}
                className="h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground">
                <option value="">Senza categoria</option>
                {categorie.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            {conferma ? (
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs" data-tinta="errore">
                <span className="argos-tinta font-medium">Eliminare documento e passaggi?</span>
                <button type="button" onClick={() => elimina.mutate()} disabled={elimina.isPending} className="rounded-md px-2 py-1 font-semibold text-white" style={{ background: "hsl(var(--tinta))" }}>Elimina</button>
                <button type="button" onClick={() => setConferma(false)} className="rounded-md border border-border px-2 py-1">No</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConferma(true)} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted">
                <Trash2 className="h-3.5 w-3.5" aria-hidden />Elimina
              </button>
            )}
          </>
        )}
      </div>
      {errore && <Problema errore={errore} />}
    </div>
  );
}

// ─── la pagina ──────────────────────────────────────────────────────────────
export default function Biblioteca({ admin, apriInMappa, documentoIniziale }: { admin: boolean; apriInMappa?: (id: number) => void; documentoIniziale?: number | null }) {
  const qc = useQueryClient();
  const stato = useQuery({
    queryKey: [...CHIAVE, "stato"], queryFn: biblioteca.stato,
    refetchInterval: q => (q.state.data?.concetti?.state === "running" || q.state.data?.cervello?.state === "running" ? 3000 : 30_000),
  });
  const jobs = useQuery({
    queryKey: [...CHIAVE, "caricamenti"], queryFn: () => biblioteca.caricamenti(30),
    refetchInterval: q => (q.state.data?.caricamenti.some(j => j.status === "queued" || j.status === "running") ? 2000 : 30_000),
  });
  const [cerca, setCerca] = useState("");
  const [filtro, setFiltro] = useState<string | null>(null);
  const [ordine, setOrdine] = useState<"recenti" | "passaggi" | "titolo">("recenti");
  const [aperto, setAperto] = useState<number | null>(documentoIniziale ?? null);
  useEffect(() => { if (documentoIniziale) setAperto(documentoIniziale); }, [documentoIniziale]);

  const aggiorna = useCallback(() => { void qc.invalidateQueries({ queryKey: CHIAVE }); }, [qc]);
  const riprova = useMutation({ mutationFn: biblioteca.riprova, onSuccess: aggiorna });
  const riprovaTutti = useMutation({ mutationFn: biblioteca.riprovaErrori, onSuccess: aggiorna });
  const concetti = useMutation({ mutationFn: biblioteca.estraiConcetti, onSuccess: aggiorna });
  const cervello = useMutation({ mutationFn: biblioteca.costruisciCervello, onSuccess: aggiorna });

  const documenti = useMemo(() => stato.data?.documenti ?? [], [stato.data]);
  const categorie = useMemo(() => elencoTinte(stato.data?.categorie ?? [], documenti.map(d => d.category)), [stato.data, documenti]);
  const passaggi = documenti.reduce((s, d) => s + d.chunks, 0);
  const maxPassaggi = Math.max(1, ...documenti.map(d => d.chunks));
  const perCategoria = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of documenti) m.set(d.category ?? "", (m.get(d.category ?? "") ?? 0) + 1);
    return m;
  }, [documenti]);
  const visibili = useMemo(() => {
    const q = cerca.trim().toLowerCase();
    const l = documenti.filter(d => (filtro === null || (d.category ?? "") === filtro) && (!q || d.title.toLowerCase().includes(q)));
    return [...l].sort((a, b) => ordine === "passaggi" ? b.chunks - a.chunks : ordine === "titolo" ? a.title.localeCompare(b.title, "it") : b.created_at.localeCompare(a.created_at));
  }, [documenti, cerca, filtro, ordine]);
  const docAperto = documenti.find(d => d.id === aperto) ?? null;
  const lista = jobs.data?.caricamenti ?? [];
  const errori = lista.filter(j => j.status === "error").length;
  const attivi = lista.filter(j => j.status === "queued" || j.status === "running").length;
  const sConc = stato.data?.concetti, sCerv = stato.data?.cervello, totali = stato.data?.totali;

  if (stato.isLoading) return <Caricamento testo="Apro la biblioteca…" />;
  if (stato.error) return <Problema errore={stato.error} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Numero etichetta="Documenti" valore={documenti.length} nota={`${categorie.length} categorie`} />
        <Numero etichetta="Passaggi" valore={passaggi.toLocaleString("it-IT")} nota="i pezzi che Argos cerca e cita" />
        <Numero etichetta="Concetti" valore={totali?.concetti ?? "—"} nota="estratti dai passaggi" tinta={sConc?.state === "error" ? "errore" : undefined} />
        <Numero etichetta="Legami del cervello" valore={totali?.legami ?? "—"} nota="fra concetti" tinta={sCerv?.state === "error" ? "errore" : undefined} />
        <Numero etichetta="In lavorazione" valore={attivi} tinta={errori ? "avviso" : attivi ? "info" : undefined} nota={errori ? `${errori} con errore` : "caricamenti in corso"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-4">
          <Riquadro titolo={<span className="inline-flex items-center gap-1.5"><UploadCloud className="h-4 w-4" aria-hidden />Carica documenti</span>}>
            {admin ? <Caricatore categorie={categorie} dopo={aggiorna} /> : (
              <Vuoto>Solo l'amministratore carica documenti. Qui sotto vedi che cosa c'è e come è stato suddiviso.</Vuoto>
            )}
          </Riquadro>
          <Riquadro titolo={<span className="inline-flex items-center gap-1.5"><Brain className="h-4 w-4" aria-hidden />Concetti e cervello</span>}>
            <p className="mb-3 text-xs text-muted-foreground">
              Dopo i caricamenti Argos estrae i concetti dai passaggi e li collega fra loro: è così che una domanda trova
              anche i documenti che usano parole diverse.
            </p>
            <div className="flex flex-wrap gap-2">
              <StatoLavoro s={sConc} nome="Concetti" />
              <StatoLavoro s={sCerv} nome="Cervello" />
            </div>
            {admin && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={sConc?.state === "running" || concetti.isPending} onClick={() => concetti.mutate()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
                  <Layers className="h-3.5 w-3.5" aria-hidden />Estrai i concetti
                </button>
                <button type="button" disabled={sCerv?.state === "running" || cervello.isPending} onClick={() => cervello.mutate()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
                  <Network className="h-3.5 w-3.5" aria-hidden />Ricostruisci i legami
                </button>
              </div>
            )}
            {(concetti.error || cervello.error) && <div className="mt-2"><Problema errore={concetti.error ?? cervello.error} /></div>}
          </Riquadro>
        </div>

        <Riquadro titolo={<span className="inline-flex items-center gap-1.5"><Loader2 className={`h-4 w-4 ${attivi ? "animate-spin" : ""}`} aria-hidden />La catena: dal file ai passaggi</span>}
          azione={admin && errori > 1 ? (
            <button type="button" onClick={() => riprovaTutti.mutate()} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-muted">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />Riprova i {errori} errori
            </button>
          ) : undefined}>
          <ol className="mb-3 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground sm:grid-cols-6" aria-label="Le fasi">
            {FASI_CARICAMENTO.map((f, i) => (
              <li key={f} className="rounded-md bg-muted/60 px-2 py-1"><b className="text-foreground">{i + 1}</b> {f}</li>
            ))}
          </ol>
          {jobs.isLoading ? <Caricamento /> : jobs.error ? <Problema errore={jobs.error} /> : lista.length ? (
            <ul className="max-h-[30rem] space-y-2 overflow-auto pr-1">
              {lista.map(j => <RigaJob key={j.id} job={j} admin={admin} riprova={id => riprova.mutate(id)} />)}
            </ul>
          ) : <Vuoto>Nessun caricamento ancora.</Vuoto>}
          {riprova.error && <div className="mt-2"><Problema errore={riprova.error} /></div>}
        </Riquadro>
      </div>

      <div className={`grid gap-4 ${docAperto ? "xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]" : ""}`}>
        <Riquadro titolo={<span className="inline-flex items-center gap-1.5"><BookOpen className="h-4 w-4" aria-hidden />I documenti</span>}
          azione={<span className="text-[11px] text-muted-foreground">{visibili.length} di {documenti.length}</span>}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input value={cerca} onChange={e => setCerca(e.target.value)} placeholder="Cerca per titolo" aria-label="Cerca per titolo"
                className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs" />
            </label>
            <select value={ordine} onChange={e => setOrdine(e.target.value as typeof ordine)} aria-label="Ordina"
              className="h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option value="recenti">Più recenti</option>
              <option value="passaggi">Più passaggi</option>
              <option value="titolo">Per titolo</option>
            </select>
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filtra per categoria">
            <button type="button" onClick={() => setFiltro(null)} aria-pressed={filtro === null}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${filtro === null ? "border-primary bg-primary/10" : "border-border hover:bg-muted"}`}>
              Tutte <span className="text-muted-foreground">{documenti.length}</span>
            </button>
            {[...categorie, ...(perCategoria.has("") ? [""] : [])].map(c => (
              <button key={c || "-"} type="button" onClick={() => setFiltro(f => (f === c ? null : c))} aria-pressed={filtro === c}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${filtro === c ? "border-primary bg-primary/10" : "border-border hover:bg-muted"}`}>
                <PuntoCategoria categoria={c || null} categorie={categorie} />{c || "Senza categoria"} <span className="text-muted-foreground">{perCategoria.get(c) ?? 0}</span>
              </button>
            ))}
          </div>
          {visibili.length ? (
            <div className="max-h-[34rem] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-card text-[11px] text-muted-foreground">
                  <tr><th className="py-1.5 font-medium">Documento</th><th className="w-40 py-1.5 font-medium">Passaggi</th><th className="w-24 py-1.5 text-right font-medium">Caricato</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibili.map(d => (
                    <tr key={d.id} className={`cursor-pointer hover:bg-muted/60 ${aperto === d.id ? "bg-muted/70" : ""}`} onClick={() => setAperto(d.id)}>
                      <td className="py-2 pr-2">
                        <button type="button" onClick={e => { e.stopPropagation(); setAperto(d.id); }} className="flex min-w-0 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
                          <PuntoCategoria categoria={d.category} categorie={categorie} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{d.title}</span>
                            <span className="block text-[10px] text-muted-foreground">{d.category ?? "Senza categoria"}</span>
                          </span>
                        </button>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 flex-1 rounded-full bg-muted" data-cat={tintaCategoria(d.category, categorie)}>
                            <span className="argos-cat-fondo block h-full rounded-full" style={{ width: `${(d.chunks / maxPassaggi) * 100}%` }} />
                          </span>
                          <span className="w-10 text-right tabular-nums">{d.chunks}</span>
                        </div>
                      </td>
                      <td className="py-2 text-right text-[11px] text-muted-foreground">{quandoFa(d.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Vuoto>{documenti.length ? "Nessun documento con questo filtro." : "La biblioteca è vuota: carica il primo documento."}</Vuoto>}
        </Riquadro>

        {docAperto && (
          <Riquadro className="xl:sticky xl:top-4 xl:self-start">
            <Documento key={docAperto.id} doc={docAperto} categorie={categorie} admin={admin} chiudi={() => setAperto(null)} apriInMappa={apriInMappa} />
          </Riquadro>
        )}
      </div>
    </div>
  );
}
