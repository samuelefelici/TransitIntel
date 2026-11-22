-- ══════════════════════════════════════════════════════════════════════
-- 0062 — Le tabelle che non usa più nessuno (tappa 7.14)
-- ──────────────────────────────────────────────────────────────────────
-- Dall'inventario delle tabelle di Cerbero (API, lavoratore, script Python,
-- contratto di Argos, Caronte): queste quattro non le legge né le scrive più
-- nessun codice. Nessuna chiave esterna punta a loro, nessuna vista le usa.
--   agenzia_gtfs               l'agenzia unica dei GTFS (0043). Dalla 0044 la
--                              sua riga è il primo gestore: le agenzie sono i
--                              gestori, e il codice non la legge più.
--   bus_routes                 le linee del primo modello di dati, mai usate:
--                              le linee sono quelle dei feed GTFS.
--   planning_scenario_edits    le modifiche e le analisi degli scenari del
--   planning_analysis_results  primo modello, mai scritte né lette.
-- Toglierle cancella i loro dati (vuote, tranne la riga già copiata nei
-- gestori): la decisione è dell'utente, nella tappa 7.14. Restano nei backup.
-- ══════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS public.agenzia_gtfs;
--> statement-breakpoint
DROP TABLE IF EXISTS public.bus_routes;
--> statement-breakpoint
DROP TABLE IF EXISTS public.planning_analysis_results;
--> statement-breakpoint
DROP TABLE IF EXISTS public.planning_scenario_edits;
