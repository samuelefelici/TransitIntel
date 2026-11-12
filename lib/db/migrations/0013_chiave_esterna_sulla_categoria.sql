-- ════════════════════════════════════════════════════════════════════════
-- 0013 — La chiave esterna sulla categoria di validità delle corse (PR 2.15c)
-- ────────────────────────────────────────────────────────────────────────
-- La terza chiave che mancava, lasciata fuori dalla 0010 apposta:
--   ps_trip_category_validity.category_id → ps_validity_categories
--
-- Fino alla PR 2.15b una categoria in uso si poteva cancellare, e sulle corse
-- restava una riga che punta a una categoria che non c'è più. Quelle righe
-- contano: il calcolo della validità le legge come «vale solo nei giorni di
-- quella categoria», cioè mai. Toglierle cambia i giorni in cui una corsa
-- vale, quindi **questa migrazione non le tocca**.
--
--   - Se non ce n'è nessuna: mette il vincolo, già valido. ON DELETE RESTRICT,
--     come fa l'API dalla 2.15b: una categoria usata da una corsa non si
--     cancella, va prima tolta dalle corse.
--   - Se ce n'è anche una sola: non mette il vincolo e lo scrive nel log
--     (WARNING), con quante sono. Il deploy va avanti: quelle corse si vedono
--     e si sistemano dalla tabella Corse («categoria cancellata»), e il vincolo
--     si mette poi a mano (DEPLOY, «Chiavi esterne di Planning Studio»).
--     Finché manca, l'API lo ricorda a ogni avvio.
--
-- Con le righe che puntano nel vuoto il vincolo non si può mettere nemmeno
-- NOT VALID: copiare una corsa, generare una cadenza o duplicare un progetto
-- copierebbero anche quelle righe, e il database le rifiuterebbe.
--
-- Lock: il vincolo prende SHARE ROW EXCLUSIVE sulle due tabelle e legge
-- ps_trip_category_validity una volta; le letture non aspettano.
-- ════════════════════════════════════════════════════════════════════════
DO $categoria$
DECLARE nel_vuoto bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
              WHERE k.conrelid = pg_catalog.to_regclass('public.ps_trip_category_validity')
                AND k.conname = 'ps_trip_category_validity_category_id_fkey') THEN
    RETURN;
  END IF;
  SELECT pg_catalog.count(*) INTO nel_vuoto
    FROM public.ps_trip_category_validity v
   WHERE NOT EXISTS (SELECT 1 FROM public.ps_validity_categories c WHERE c.id = v.category_id);
  IF nel_vuoto > 0 THEN
    RAISE WARNING '0013: % righe di ps_trip_category_validity puntano a una categoria cancellata: la chiave esterna sulla categoria NON è stata messa. Quelle corse si sistemano dalla tabella Corse; poi il vincolo si mette a mano (DEPLOY, «Chiavi esterne di Planning Studio»)', nel_vuoto;
    RETURN;
  END IF;
  ALTER TABLE public.ps_trip_category_validity
    ADD CONSTRAINT ps_trip_category_validity_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES public.ps_validity_categories(id) ON DELETE RESTRICT;
END $categoria$;
