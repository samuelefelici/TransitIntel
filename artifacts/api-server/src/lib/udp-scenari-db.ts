/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GLI SCENARI DI UN'UDP — lettura, eliminazione e rotte
 * ───────────────────────────────────────────────────────────────────────────
 *   GET  /planning-studio/projects/:id/validity-units/:unitId/scenari
 *        l'anteprima: turni macchina e turni guida dell'UDP, blocchi, relazioni
 *   POST /planning-studio/projects/:id/validity-units/:unitId/scenari/elimina
 *        { turniMacchina: id[], turniGuida: id[] } — gli id dell'anteprima
 *
 * Le regole stanno in udp-scenari.ts. Qui: chi può (lettura del progetto per
 * l'anteprima; per eliminare, scrittura sul progetto, scrittura sull'area
 * Turni E proprietà dei progetti di esercizio coinvolti, o amministratore),
 * niente mentre un giro dello
 * scheduler è in corso sul progetto, e i controlli rifatti DENTRO la
 * transazione con le righe bloccate: fra anteprima e conferma il roster può
 * aver pubblicato.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { puoSuUna, type Diritti } from "@workspace/permessi";
import { numeroVettureSql } from "./numero-vetture";
import { withVia } from "./agent-context";
import type { Ex } from "./anagrafica-store";
import {
  anteprima, controllaSelezione, leggiRichiesta, usiVuoti, TESTO_BLOCCO,
  type TurniMacchina, type TurniGuida, type Usi,
} from "./udp-scenari";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (ids: string[]) => `{${ids.filter(x => UUID_RE.test(x)).join(",")}}`;
const rows = (r: any): any[] => r?.rows ?? [];
const iso = (x: unknown): string | null => x == null ? null : (x instanceof Date ? x.toISOString() : String(x));

/** Un giro dello scheduler più vecchio di così non è «in corso»: è un giro rimasto appeso. */
const GIRO_APPESO_ORE = 6;

export interface UdpConScenari {
  udp: { id: string; nome: string; corse: number };
  progetti: { id: string; nome: string; proprietario: string | null }[];
  turniMacchina: TurniMacchina[];
  turniGuida: TurniGuida[];
}

/** L'UDP del progetto e i suoi scenari (null se l'UDP non è di quel progetto). */
export async function leggiScenariUdp(psProjectId: string, unitId: string, ex: Ex = db, perAggiornare = false): Promise<UdpConScenari | null> {
  const u = rows(await ex.execute(sql`
    SELECT id::text, name, COALESCE(jsonb_array_length(trip_ids), 0) AS corse
      FROM ps_validity_units WHERE id = ${unitId}::uuid AND project_id = ${psProjectId}::uuid`))[0];
  if (!u) return null;
  const progetti = rows(await ex.execute(sql`
    SELECT id::text, name, owner_user_id::text AS owner FROM scheduling_projects
     WHERE validity_unit_id = ${unitId}::uuid ORDER BY created_at`))
    .map(p => ({ id: String(p.id), nome: String(p.name ?? ""), proprietario: p.owner ? String(p.owner) : null }));
  const pIds = progetti.map(p => p.id);
  if (!pIds.length) return { udp: { id: u.id, nome: u.name ?? "", corse: Number(u.corse) || 0 }, progetti, turniMacchina: [], turniGuida: [] };
  // nella transazione le righe si bloccano: lo stato «in esercizio» non cambia sotto i piedi
  const blocca = perAggiornare ? sql`FOR UPDATE` : sql``;
  const tm = rows(await ex.execute(sql`
    SELECT s.id::text, s.name, s.date, s.created_at, s.project_id::text AS progetto,
           COALESCE(s.is_operational, false) AS op, ${numeroVettureSql(sql`s.result`)} AS vetture
      FROM service_program_scenarios s
     WHERE s.project_id = ANY(${uuids(pIds)}::uuid[])
     ORDER BY s.created_at DESC NULLS LAST ${blocca}`)).map((r): TurniMacchina => ({
    id: String(r.id), nome: String(r.name ?? ""), data: r.date ?? null, creato: iso(r.created_at),
    progettoId: String(r.progetto), inEsercizio: !!r.op, vetture: r.vetture == null ? null : Number(r.vetture),
  }));
  const tg = rows(await ex.execute(sql`
    SELECT d.id::text, d.name, d.service_program_scenario_id::text AS tm, d.created_at,
           d.project_id::text AS progetto, COALESCE(d.is_operational, false) AS op,
           CASE WHEN jsonb_typeof(d.result->'driverShifts') = 'array'
                THEN jsonb_array_length(d.result->'driverShifts') END AS turni
      FROM driver_shift_scenarios d
     WHERE d.project_id = ANY(${uuids(pIds)}::uuid[])
        OR d.service_program_scenario_id IN (
             SELECT s.id FROM service_program_scenarios s WHERE s.project_id = ANY(${uuids(pIds)}::uuid[]))
     ORDER BY d.created_at DESC NULLS LAST ${blocca}`)).map((r): TurniGuida => ({
    id: String(r.id), nome: String(r.name ?? ""), turniMacchinaId: r.tm ? String(r.tm) : null, creato: iso(r.created_at),
    progettoId: r.progetto ? String(r.progetto) : null, inEsercizio: !!r.op, turni: r.turni == null ? null : Number(r.turni),
  }));
  return { udp: { id: u.id, nome: u.name ?? "", corse: Number(u.corse) || 0 }, progetti, turniMacchina: tm, turniGuida: tg };
}

/** Le tabelle che esistono (roster ed esercizio nascono con le loro migrazioni). */
async function esistenti(ex: Ex, nomi: string[]): Promise<Set<string>> {
  const r = rows(await ex.execute(sql`
    SELECT n FROM unnest(${`{${nomi.join(",")}}`}::text[]) AS n WHERE to_regclass('public.' || n) IS NOT NULL`));
  return new Set(r.map(x => String(x.n)));
}

/**
 * Chi usa questi scenari fuori dalla Fucina: il roster (assegnazioni, giorni
 * pubblicati) e le giornate di esercizio (turni macchina, vetture, corse).
 * Senza colonne indicizzate su questi id: una lettura per tabella, va bene
 * per un'operazione rara.
 */
export async function usiDegliScenari(tmIds: string[], tgIds: string[], ex: Ex = db): Promise<Usi> {
  const usi = usiVuoti();
  if (!tmIds.length && !tgIds.length) return usi;
  const ci = await esistenti(ex, ["roster_assignments", "roster_turni_pubblicati",
    "esercizio_turni_macchina", "esercizio_vetture", "esercizio_corse"]);
  const tm = uuids(tmIds), tg = uuids(tgIds);
  const metti = (dove: Set<string>, r: any) => { for (const x of rows(r)) if (x.id) dove.add(String(x.id)); };
  if (ci.has("roster_assignments")) {
    metti(usi.roster, await ex.execute(sql`
      SELECT DISTINCT dss_id::text AS id FROM roster_assignments WHERE dss_id = ANY(${tg}::uuid[])`));
  }
  if (ci.has("roster_turni_pubblicati")) {
    metti(usi.roster, await ex.execute(sql`
      SELECT DISTINCT dss_id::text AS id FROM roster_turni_pubblicati WHERE dss_id = ANY(${tg}::uuid[])`));
    metti(usi.roster, await ex.execute(sql`
      SELECT DISTINCT vss_id::text AS id FROM roster_turni_pubblicati WHERE vss_id = ANY(${tm}::uuid[])`));
  }
  if (ci.has("esercizio_turni_macchina")) {
    metti(usi.giornateEsercizio, await ex.execute(sql`
      SELECT DISTINCT vss_id::text AS id FROM esercizio_turni_macchina WHERE vss_id = ANY(${tm}::uuid[])`));
    metti(usi.giornateEsercizio, await ex.execute(sql`
      SELECT DISTINCT dss_id::text AS id FROM esercizio_turni_macchina WHERE dss_id = ANY(${tg}::uuid[])`));
  }
  if (ci.has("esercizio_corse")) {
    metti(usi.giornateEsercizio, await ex.execute(sql`
      SELECT DISTINCT vss_id::text AS id FROM esercizio_corse WHERE vss_id = ANY(${tm}::uuid[])`));
    metti(usi.giornateEsercizio, await ex.execute(sql`
      SELECT DISTINCT dss_id::text AS id FROM esercizio_corse WHERE dss_id = ANY(${tg}::uuid[])`));
  }
  if (ci.has("esercizio_vetture")) {
    metti(usi.giornateEsercizio, await ex.execute(sql`
      SELECT DISTINCT vss_id::text AS id FROM esercizio_vetture WHERE vss_id = ANY(${tm}::uuid[])`));
  }
  return usi;
}

/** Le relazioni di processo di questi scenari (non hanno chiave esterna: si contano e si tolgono a mano). */
async function relazioni(ex: Ex, tmIds: string[], tgIds: string[], elimina: boolean): Promise<number> {
  if (!(await esistenti(ex, ["process_reports"])).has("process_reports")) return 0;
  const dove = sql`scenario_id = ANY(${uuids(tmIds)}::uuid[]) OR dss_id = ANY(${uuids(tgIds)}::uuid[])`;
  if (elimina) return rows(await ex.execute(sql`DELETE FROM process_reports WHERE ${dove} RETURNING id`)).length;
  return Number(rows(await ex.execute(sql`SELECT count(*)::int AS n FROM process_reports WHERE ${dove}`))[0]?.n ?? 0);
}

/** Un giro dello scheduler in corso sul progetto (non si cancella sotto i suoi piedi). */
export async function giroInCorso(psProjectId: string, ex: Ex = db): Promise<string | null> {
  const r = rows(await ex.execute(sql`
    SELECT id::text FROM agent_optimize_jobs
     WHERE ps_project_id = ${psProjectId}::uuid
       AND status NOT IN ('done', 'error', 'stopped', 'failed', 'cancelled', 'completed')
       AND created_at > now() - make_interval(hours => ${GIRO_APPESO_ORE})
     LIMIT 1`));
  return r[0]?.id ?? null;
}

export async function anteprimaScenariUdp(psProjectId: string, unitId: string, ex: Ex = db) {
  const s = await leggiScenariUdp(psProjectId, unitId, ex);
  if (!s) return null;
  const usi = await usiDegliScenari(s.turniMacchina.map(x => x.id), s.turniGuida.map(x => x.id), ex);
  const a = anteprima(s.turniMacchina, s.turniGuida, usi);
  return {
    udp: s.udp,
    progetti: s.progetti.map(p => ({ id: p.id, nome: p.nome })),
    turniMacchina: a.turniMacchina,
    turniGuida: a.turniGuida,
    eliminabili: a.eliminabili,
    bloccati: a.bloccati,
    relazioni: await relazioni(ex, a.eliminabili.turniMacchina, a.eliminabili.turniGuida, false),
    giroInCorso: await giroInCorso(psProjectId, ex),
    motivi: TESTO_BLOCCO,
  };
}

export type EsitoEliminazione =
  | { ok: true; eliminati: { turniMacchina: string[]; turniGuida: string[]; relazioni: number }; progetti: string[] }
  | { ok: false; stato: number; errore: string; ids?: string[] };

/**
 * Elimina gli scenari indicati, tutto o niente. `puoEliminare` decide sui
 * progetti di esercizio coinvolti (proprietario o amministratore): lo si
 * passa da fuori perché la transazione non sa chi chiede.
 */
export async function eliminaScenariUdp(
  psProjectId: string, unitId: string, body: unknown,
  puoEliminare: (progetti: { id: string; proprietario: string | null }[]) => boolean,
): Promise<EsitoEliminazione> {
  const req = leggiRichiesta(body);
  if (!req.ok) return { ok: false, stato: 400, errore: req.errore };
  const giro = await giroInCorso(psProjectId);
  if (giro) return { ok: false, stato: 409, errore: `un giro dello scheduler è in corso su questo progetto (${giro.slice(0, 8)}): aspetta che finisca` };
  class Rifiuto extends Error { constructor(public esito: EsitoEliminazione) { super("rifiuto"); } }
  try {
    return await db.transaction(async (tx) => {
      const s = await leggiScenariUdp(psProjectId, unitId, tx as unknown as Ex, true);
      if (!s) throw new Rifiuto({ ok: false, stato: 404, errore: "UDP non trovata in questo progetto" });
      const usi = await usiDegliScenari(s.turniMacchina.map(x => x.id), s.turniGuida.map(x => x.id), tx as unknown as Ex);
      const sel = controllaSelezione(req, s.turniMacchina, s.turniGuida, usi);
      if (!sel.ok) throw new Rifiuto({ ok: false, stato: sel.stato, errore: sel.errore, ids: sel.ids });
      // i progetti toccati: quelli degli scenari scelti
      const toccati = new Set<string>();
      for (const id of sel.turniMacchina) toccati.add(s.turniMacchina.find(x => x.id === id)!.progettoId);
      for (const id of sel.turniGuida) {
        const g = s.turniGuida.find(x => x.id === id)!;
        const p = g.progettoId ?? s.turniMacchina.find(x => x.id === g.turniMacchinaId)?.progettoId;
        if (p) toccati.add(p);
      }
      const progetti = s.progetti.filter(p => toccati.has(p.id));
      if (!puoEliminare(progetti)) {
        throw new Rifiuto({ ok: false, stato: 403, errore: "solo il proprietario del progetto di esercizio (o un amministratore) elimina i suoi scenari" });
      }
      const ex = tx as unknown as Ex;
      const tm = uuids(sel.turniMacchina), tg = uuids(sel.turniGuida);
      const nRel = await relazioni(ex, sel.turniMacchina, sel.turniGuida, true);
      // chi indicava questi come «versione nuova» torna la versione più recente
      await ex.execute(sql`UPDATE service_program_scenarios SET superseded_by = NULL WHERE superseded_by = ANY(${tm}::uuid[])`);
      await ex.execute(sql`UPDATE driver_shift_scenarios SET superseded_by = NULL WHERE superseded_by = ANY(${tg}::uuid[])`);
      const viaTg = rows(await ex.execute(sql`DELETE FROM driver_shift_scenarios WHERE id = ANY(${tg}::uuid[]) RETURNING id::text`)).map(x => String(x.id));
      const viaTm = rows(await ex.execute(sql`DELETE FROM service_program_scenarios WHERE id = ANY(${tm}::uuid[]) RETURNING id::text`)).map(x => String(x.id));
      return { ok: true as const, eliminati: { turniMacchina: viaTm, turniGuida: viaTg, relazioni: nRel }, progetti: progetti.map(p => p.id) };
    });
  } catch (e: any) {
    if (e instanceof Rifiuto) return e.esito;
    // pubblicato nel roster fra la lettura e la cancellazione: lo ferma la chiave esterna
    if ((e?.cause?.code ?? e?.code) === "23503") {
      return { ok: false, stato: 409, errore: "uno scenario è appena finito nel roster: non si cancella niente, rifai l'anteprima" };
    }
    throw e;
  }
}

/* ─────────────────────────────── rotte ─────────────────────────────── */

const router: IRouter = Router();

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

/** Il progetto Planning Studio, se l'utente lo vede (e, con needWrite, ci scrive). */
async function progettoPs(projectId: string, userId: string, needWrite: boolean): Promise<boolean> {
  const r = rows(await db.execute(sql`
    SELECT CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner' ELSE pm.role END AS ruolo
      FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1`))[0];
  if (!r) return false;
  return !needWrite || r.ruolo === "owner" || r.ruolo === "editor";
}

router.get("/planning-studio/projects/:id/validity-units/:unitId/scenari", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const { id, unitId } = req.params as { id: string; unitId: string };
  if (!UUID_RE.test(id) || !UUID_RE.test(unitId)) { res.status(400).json({ error: "id non valido" }); return; }
  if (!(await progettoPs(id, userId, false))) { res.status(404).json({ error: "progetto non trovato" }); return; }
  try {
    const a = await anteprimaScenariUdp(id, unitId);
    if (!a) { res.status(404).json({ error: "UDP non trovata in questo progetto" }); return; }
    res.json(a);
  } catch (e: any) {
    req.log?.error?.(e, "anteprima scenari UDP");
    res.status(500).json({ error: "anteprima degli scenari non riuscita" });
  }
});

router.post("/planning-studio/projects/:id/validity-units/:unitId/scenari/elimina", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const { id, unitId } = req.params as { id: string; unitId: string };
  if (!UUID_RE.test(id) || !UUID_RE.test(unitId)) { res.status(400).json({ error: "id non valido" }); return; }
  const admin = (req as any).user?.role === "admin";
  // la rotta sta sotto /planning-studio (area Rete): si cancellano turni, serve anche la scrittura sui Turni
  const diritti = (req as any).user?.diritti as Diritti | undefined;
  if (!admin && !(diritti && puoSuUna(diritti, ["turni"], "S"))) {
    res.status(403).json({ error: "serve la scrittura sull'area «Turni» per eliminare scenari" }); return;
  }
  if (!(await progettoPs(id, userId, true))) { res.status(403).json({ error: "serve il permesso di scrittura sul progetto" }); return; }
  try {
    const esito = await eliminaScenariUdp(id, unitId, req.body,
      progetti => admin || progetti.every(p => p.proprietario === userId));
    if (!esito.ok) { res.status(esito.stato).json({ error: esito.errore, ...(esito.ids ? { ids: esito.ids.slice(0, 100) } : {}) }); return; }
    const payload = withVia({
      udpId: unitId,
      turniMacchina: esito.eliminati.turniMacchina,
      turniGuida: esito.eliminati.turniGuida,
      relazioni: esito.eliminati.relazioni,
    });
    // nel registro del progetto Planning Studio e in quello di ogni progetto di esercizio toccato
    try {
      await db.execute(sql`
        INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, target_id, payload)
        VALUES (${id}::uuid, ${userId}::uuid, 'udp.scenari.elimina', 'validity_unit', ${unitId}::uuid, ${JSON.stringify(payload)}::jsonb)`);
      for (const p of esito.progetti) {
        await db.execute(sql`
          INSERT INTO project_activity_log (project_id, user_id, action, target_type, target_id, payload)
          VALUES (${p}::uuid, ${userId}::uuid, 'scenari.elimina', 'project', ${p}::uuid, ${JSON.stringify(payload)}::jsonb)`);
      }
    } catch (e: any) {
      req.log?.warn?.(e, "registro dell'eliminazione degli scenari non scritto");
    }
    res.json({
      ok: true,
      eliminati: {
        turniMacchina: esito.eliminati.turniMacchina.length,
        turniGuida: esito.eliminati.turniGuida.length,
        relazioni: esito.eliminati.relazioni,
      },
      ids: { turniMacchina: esito.eliminati.turniMacchina, turniGuida: esito.eliminati.turniGuida },
    });
  } catch (e: any) {
    req.log?.error?.(e, "eliminazione scenari UDP");
    res.status(500).json({ error: "eliminazione degli scenari non riuscita: non è cambiato niente" });
  }
});

export default router;
