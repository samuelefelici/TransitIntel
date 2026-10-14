/**
 * ═══════════════════════════════════════════════════════════════════════════
 * URBANA O EXTRAURBANA — il tipo di servizio di un'Unità di Progettazione
 * ───────────────────────────────────────────────────────────────────────────
 * Decide il riposo minimo fra due turni nel Roster: 8h urbano, 9h extraurbano.
 * L'UDP ha un campo `service_type` che sceglie l'utente; finché non lo
 * sceglie vale la proposta fatta dalle sue linee (lib/reti-linee.ts): urbana
 * se tutte le sue corse sono su linee urbane, extraurbana se almeno una non
 * lo è, perché nel dubbio vale la regola più severa.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql } from "drizzle-orm";
import { servizioDellaLinea } from "./reti-linee";
import type { Ex } from "./anagrafica-store";

export type Servizio = "urbano" | "extraurbano";

export interface ServizioUdp {
  udpId: string;
  nome: string | null;
  /** il tipo scelto sull'UDP, se qualcuno l'ha scelto */
  scelto: Servizio | null;
  /** il tipo che dicono le linee delle sue corse */
  proposto: Servizio | null;
  corseUrbane: number;
  corseExtraurbane: number;
}

export const SERVIZI: readonly Servizio[] = ["urbano", "extraurbano"];
export const eServizio = (v: unknown): v is Servizio => v === "urbano" || v === "extraurbano";

/** La proposta dalle corse: urbana solo se sono tutte urbane; senza corse, nessuna proposta. */
export function propostaServizio(corseUrbane: number, corseExtraurbane: number): Servizio | null {
  if (corseExtraurbane > 0) return "extraurbano";
  return corseUrbane > 0 ? "urbano" : null;
}

/** Il tipo che vale per un'UDP: quello scelto, altrimenti la proposta. */
export const servizioEffettivo = (u: Pick<ServizioUdp, "scelto" | "proposto">): Servizio | null => u.scelto ?? u.proposto;

/**
 * Tipo scelto e proposta di più UDP in una query. Le corse si contano per
 * linea (ps_routes.short_name) e si classificano qui, con la stessa regola
 * delle reti tariffarie. `to_jsonb(u)` legge `service_type` anche dove la
 * colonna non c'è ancora (il modulo UDP la aggiunge al primo uso), e si
 * calcola una volta per UDP, prima di aprire l'elenco delle corse: dopo,
 * costerebbe una volta per corsa, con tutte le corse dentro.
 */
export async function serviziDelleUdp(ex: Ex, udpIds: string[]): Promise<Map<string, ServizioUdp>> {
  const ids = [...new Set(udpIds.filter(id => /^[0-9a-f-]{36}$/i.test(id)))];
  const out = new Map<string, ServizioUdp>();
  if (!ids.length) return out;
  const r = await ex.execute(sql`
    WITH udp AS MATERIALIZED (
      SELECT u.id, u.name, to_jsonb(u)->>'service_type' AS scelto,
             CASE WHEN jsonb_typeof(u.trip_ids) = 'array' THEN u.trip_ids ELSE '[]'::jsonb END AS corse
        FROM ps_validity_units u
       WHERE u.id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
    )
    SELECT udp.id::text AS udp_id, udp.name, udp.scelto, r.short_name, count(pt.id)::int AS corse
      FROM udp
      LEFT JOIN LATERAL jsonb_array_elements_text(udp.corse) t(id) ON true
      LEFT JOIN ps_trips pt
             ON pt.id = CASE WHEN t.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t.id::uuid END
      LEFT JOIN ps_routes r ON r.id = pt.route_id
     GROUP BY udp.id, udp.name, udp.scelto, r.short_name`);
  for (const x of r.rows ?? []) {
    const u = out.get(x.udp_id) ?? {
      udpId: x.udp_id, nome: x.name ?? null, scelto: eServizio(x.scelto) ? x.scelto : null,
      proposto: null, corseUrbane: 0, corseExtraurbane: 0,
    };
    /* una corsa che non si ritrova fra le corse del progetto non dice niente */
    if (x.short_name != null && Number(x.corse) > 0) {
      if (servizioDellaLinea(x.short_name) === "urbano") u.corseUrbane += Number(x.corse);
      else u.corseExtraurbane += Number(x.corse);
    }
    out.set(x.udp_id, u);
  }
  for (const u of out.values()) u.proposto = propostaServizio(u.corseUrbane, u.corseExtraurbane);
  return out;
}
