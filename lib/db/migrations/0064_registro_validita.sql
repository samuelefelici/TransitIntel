-- ══════════════════════════════════════════════════════════════════════
-- 0064 — Il registro delle modifiche sorveglia la validità delle corse (tappa 7.18)
-- ──────────────────────────────────────────────────────────────────────
-- Nella 2.11 la famiglia della validità era rimasta fuori: le sue scritture
-- avrebbero sporcato il registro. Dalla 7.18:
--   - il ricalcolo delle categorie che parte dalla lista delle corse (una
--     lettura) gira come «sistema:categorie», senza l'utente che ha aperto la
--     pagina;
--   - il ricalcolo delle categorie e l'import dai calendari scrivono a insiemi
--     dentro una transazione: nel registro diventano riepiloghi.
-- Le otto tabelle, con la regola di ognuna:
--   ps_trip_day_validity           la matrice corsa × giorno-tipo; valori
--   ps_trip_category_validity      le categorie di validità delle corse; valori
--   ps_trip_exceptions             le date in più / in meno delle corse; valori
--   ps_validity_category_calendar  data → categoria, ricalcolato dal profilo:
--                                  sempre riepilogo, solo nomi
--   ps_day_calendar                data → giorno-tipo; valori
--   ps_day_types                   i giorni-tipo; valori
--   ps_validity_categories         le categorie (tabella comune); valori
--   ps_calendar_profiles           il calendario aziendale del progetto; valori,
--                                  fuori il marcatore dell'ultimo ricalcolo
-- ══════════════════════════════════════════════════════════════════════
SELECT registro.sorveglia('public.ps_trip_day_validity', ARRAY['trip_id', 'day_type_id'], 'corsa', 'trip_id', true, '{}', ARRAY['updated_at']);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_trip_category_validity', ARRAY['trip_id', 'category_id'], 'corsa', 'trip_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_trip_exceptions', ARRAY['trip_id', 'date'], 'corsa', 'trip_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_validity_category_calendar', ARRAY['project_id', 'date'], 'progetto_ps', 'project_id', false, '{}', '{}', '{}', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_day_calendar', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_day_types', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_validity_categories', ARRAY['id'], NULL, NULL, true, '{}', ARRAY['updated_at']);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_calendar_profiles', ARRAY['project_id'], 'progetto_ps', 'project_id', true, '{}', ARRAY['updated_at', 'categories_synced_at']);
