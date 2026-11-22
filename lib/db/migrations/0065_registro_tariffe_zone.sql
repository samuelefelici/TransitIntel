-- ══════════════════════════════════════════════════════════════════════
-- 0065 — Il registro delle modifiche sorveglia le tariffe a zone (tappa 7.19)
-- ──────────────────────────────────────────────────────────────────────
-- Nella 2.11 le tariffe a zone erano rimaste fuori: si rigeneravano una riga
-- per volta, senza transazione. Dalla 7.19 ogni rigenerazione (zone delle
-- linee, regole OD, zone dai cluster, cluster automatici, nodi tariffari)
-- scrive a insiemi dentro una transazione, nel registro come riepilogo; uno
-- spostamento a mano di una fermata fra due cluster è una transazione sola.
-- Le cinque tabelle, con la regola di ognuna (ambito: il feed):
--   gtfs_fare_areas                le zone; valori
--   gtfs_stop_areas                fermata → zona, sempre rigenerata:
--                                  sempre riepilogo, solo nomi
--   gtfs_fare_leg_rules            le regole OD, sempre rigenerate:
--                                  sempre riepilogo, solo nomi
--   gtfs_fare_zone_clusters        i cluster; valori, il poligono solo nome
--   gtfs_fare_zone_cluster_stops   fermata → cluster; valori
-- ══════════════════════════════════════════════════════════════════════
SELECT registro.sorveglia('public.gtfs_fare_areas', ARRAY['id'], 'feed', 'feed_id', true, '{}', ARRAY['updated_at']);
--> statement-breakpoint
SELECT registro.sorveglia('public.gtfs_stop_areas', ARRAY['id'], 'feed', 'feed_id', false, '{}', '{}', '{}', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.gtfs_fare_leg_rules', ARRAY['id'], 'feed', 'feed_id', false, '{}', '{}', '{}', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.gtfs_fare_zone_clusters', ARRAY['id'], 'feed', 'feed_id', true, '{}', ARRAY['updated_at'], ARRAY['polygon']);
--> statement-breakpoint
SELECT registro.sorveglia('public.gtfs_fare_zone_cluster_stops', ARRAY['id'], 'feed', 'feed_id', true, '{}', ARRAY['assigned_at']);
