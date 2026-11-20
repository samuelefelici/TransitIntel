-- ══════════════════════════════════════════════════════════════════════
-- 0058 — Il pagamento con carta a bordo come dato dell'azienda (tappa 6.38)
-- ──────────────────────────────────────────────────────────────────────
-- Sugli autobus dove il sistema di bigliettazione lo permette si sale
-- avvicinando al validatore una carta bancaria contactless, o uno smartphone
-- o un orologio con un portafoglio digitale. Non è un biglietto: è un altro
-- modo di accedere, con le sue tariffe, che il sistema calcola alla fine
-- della giornata applicando la più conveniente:
--   - un prezzo per il primo viaggio, valido per un certo tempo; uno per il
--     secondo, dopo quel tempo; uno per il terzo;
--   - un massimale nella finestra di ore dal primo tap, per l'urbano e per
--     l'extraurbano, e un massimale unico se si usano tutti e due.
-- Le regole le decide chi fissa le tariffe (la Regione, il Comune) e valgono
-- sulle reti dove il sistema è attivo. Qui:
--   contactless          una riga: il massimale unico, la finestra in ore,
--                        il supporto con cui si paga (supporti_catalogo, per
--                        il GTFS: tipo cEMV)
--   contactless_tariffe  per tipo di rete (urbano, extraurbano): i prezzi del
--                        primo, secondo e terzo viaggio, la validità in
--                        minuti, il massimale
--   contactless_reti     le reti dove si può pagare così
-- Le cambia l'amministratore (Amministrazione › Azienda) e ogni modifica
-- resta nel registro. Le regole della Regione entrano solo
-- nell'installazione di Conerobus (la riga di azienda con gtfs_agency_id
-- «conerobus»), attive sull'urbano di Ancona come oggi; una nuova parte senza.
-- ══════════════════════════════════════════════════════════════════════
DO $carta$
BEGIN
  IF pg_catalog.to_regclass('public.contactless') IS NULL THEN
    CREATE TABLE public.contactless (
      chiave           text PRIMARY KEY DEFAULT 'unica' CONSTRAINT contactless_una_riga CHECK (chiave = 'unica'),
      massimale_unico  numeric(6,2) CONSTRAINT contactless_massimale_unico CHECK (massimale_unico > 0 AND massimale_unico <= 999.99),
      finestra_ore     smallint NOT NULL DEFAULT 24 CONSTRAINT contactless_finestra CHECK (finestra_ore BETWEEN 1 AND 72),
      supporto         text REFERENCES public.supporti_catalogo (supporto) ON DELETE SET NULL,
      aggiornato_il    timestamptz NOT NULL DEFAULT now()
    );
  END IF;
  IF pg_catalog.to_regclass('public.contactless_tariffe') IS NULL THEN
    CREATE TABLE public.contactless_tariffe (
      tipo             text PRIMARY KEY CONSTRAINT contactless_tariffe_tipo CHECK (tipo IN ('urbano', 'extraurbano')),
      primo            numeric(6,2) NOT NULL CONSTRAINT contactless_tariffe_primo CHECK (primo > 0 AND primo <= 999.99),
      secondo          numeric(6,2) NOT NULL CONSTRAINT contactless_tariffe_secondo CHECK (secondo >= 0 AND secondo <= 999.99),
      terzo            numeric(6,2) NOT NULL CONSTRAINT contactless_tariffe_terzo CHECK (terzo >= 0 AND terzo <= 999.99),
      validita_minuti  smallint NOT NULL CONSTRAINT contactless_tariffe_validita CHECK (validita_minuti BETWEEN 1 AND 1440),
      massimale        numeric(6,2) NOT NULL CONSTRAINT contactless_tariffe_massimale CHECK (massimale > 0 AND massimale <= 999.99),
      CONSTRAINT contactless_tariffe_massimale_primo CHECK (massimale >= primo)
    );
  END IF;
  IF pg_catalog.to_regclass('public.contactless_reti') IS NULL THEN
    CREATE TABLE public.contactless_reti (
      rete             text PRIMARY KEY REFERENCES public.reti (rete) ON DELETE CASCADE
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.contactless OWNER TO cerbero_owner;
    ALTER TABLE public.contactless_tariffe OWNER TO cerbero_owner;
    ALTER TABLE public.contactless_reti OWNER TO cerbero_owner;
  END IF;
END $carta$;
--> statement-breakpoint
SELECT registro.sorveglia('public.contactless', ARRAY['chiave'], NULL, NULL, true, '{}', ARRAY['aggiornato_il'], '{}');
--> statement-breakpoint
SELECT registro.sorveglia('public.contactless_tariffe', ARRAY['tipo'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
SELECT registro.sorveglia('public.contactless_reti', ARRAY['rete'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
-- I dati come cerbero_owner, solo se sono già sue le tabelle che si toccano
-- (su un database appena creato sono ancora di chi migra) e se può già usare
-- lo schema: dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni.
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.contactless'),
                                        pg_catalog.to_regclass('public.contactless_tariffe'), pg_catalog.to_regclass('public.contactless_reti'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
-- Le regole della Regione per il pagamento con carta, solo nell'installazione
-- di Conerobus e solo se non ci sono già: una seconda esecuzione non rimette
-- sopra quelle che l'amministratore ha cambiato.
INSERT INTO public.contactless (chiave, massimale_unico, finestra_ore, supporto)
SELECT 'unica', 10, 24, (SELECT s.supporto FROM public.supporti_catalogo s WHERE s.supporto = 'cemv')
 WHERE EXISTS (SELECT 1 FROM public.azienda WHERE gtfs_agency_id = 'conerobus')
ON CONFLICT (chiave) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.contactless_tariffe (tipo, primo, secondo, terzo, validita_minuti, massimale)
SELECT t.tipo, t.primo, t.secondo, t.terzo, t.validita, t.massimale
  FROM (VALUES ('urbano', 2.00, 2.00, 1.00, 60, 5.00), ('extraurbano', 4.00, 4.00, 2.00, 60, 10.00))
       AS t(tipo, primo, secondo, terzo, validita, massimale)
 WHERE EXISTS (SELECT 1 FROM public.azienda WHERE gtfs_agency_id = 'conerobus')
ON CONFLICT (tipo) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.contactless_reti (rete)
SELECT r.rete FROM public.reti r
 WHERE r.rete = 'urbano_ancona'
   AND EXISTS (SELECT 1 FROM public.azienda WHERE gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.contactless_reti)
ON CONFLICT (rete) DO NOTHING;
--> statement-breakpoint
RESET ROLE;
