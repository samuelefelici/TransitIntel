/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE RETI DELLE LINEE — urbano o extraurbano, dal nome della linea
 * ───────────────────────────────────────────────────────────────────────────
 * La regola con cui le reti tariffarie classificano le linee Conerobus/ATMA,
 * qui in un posto solo perché serve anche altrove: le Unità di Progettazione
 * la usano per proporre se sono urbane o extraurbane (riposo minimo 8h o 9h
 * fra due turni nel Roster).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** La rete di default di una linea dal suo route_short_name. */
export function classifyRoute(shortName: string): string {
  if (!shortName) return "extraurbano";
  const s = shortName.trim().toUpperCase();

  // Urbano Jesi — starts with "JE"
  if (s.startsWith("JE")) return "urbano_jesi";

  // Urbano Falconara — starts with "Y"
  if (s.startsWith("Y")) return "urbano_falconara";

  // Urbano Senigallia — BUS* e BUSS* (es. BUS3, BUS5, BUS6, BUS7, BUS8, BUS10, BUS87, BUSS2, BUSS3)
  if (/^BUSS?\d/.test(s)) return "urbano_senigallia";

  // Urbano Castelfidardo — CIRCA e CIRCB
  if (s === "CIRCA" || s === "CIRCB") return "urbano_castelfidardo";

  // Urbano Ancona — starts with a digit, OR is C.D., C.S., or similar single-letter+dot combos
  if (/^\d/.test(s)) return "urbano_ancona";
  if (/^[A-Z]\.[A-Z]\.?$/.test(s)) return "urbano_ancona"; // C.D., C.S., etc.

  // Everything else → extraurbano
  return "extraurbano";
}

/** Urbano o extraurbano: le reti urbane (Ancona, Jesi, Falconara, Senigallia, Castelfidardo) sono urbane. */
export function servizioDellaLinea(shortName: string | null | undefined): "urbano" | "extraurbano" {
  return classifyRoute(shortName ?? "").startsWith("urbano") ? "urbano" : "extraurbano";
}
