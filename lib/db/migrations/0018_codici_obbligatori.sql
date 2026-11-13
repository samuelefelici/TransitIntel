-- ════════════════════════════════════════════════════════════════════════
-- 0018 — Il codice stabile diventa obbligatorio (PR 3.1)
-- ────────────────────────────────────────────────────────────────────────
-- La 0017 ha dato un codice a ogni corsa, fermata e linea. Da qui:
--
--   - il codice è obbligatorio (NOT NULL);
--   - ogni riga nuova che non lo porta ne riceve uno dal default: «CB-» più
--     la lettera del tipo e il prossimo numero di ps_codici_seq. Così anche
--     il container di prima, che durante il deploy serve ancora e non conosce
--     la colonna, continua a creare corse, fermate e linee;
--   - è senza spazi ai lati, da 1 a 200 caratteri, senza caratteri di
--     controllo (finisce in un file CSV);
--   - è unico dentro il progetto. Due progetti possono avere lo stesso
--     codice: è così che la copia di un programma tiene i codici
--     dell'originale.
--
-- Nel default e nel vincolo solo funzioni ammesse (README, «Funzioni nei
-- default, nei vincoli e negli indici»): nextval, btrim, char_length e
-- operatori di sistema.
--
-- Lock: le tabelle sono già chiuse dalla 0017, nella stessa transazione. Il
-- NOT NULL e il vincolo leggono la tabella una volta, l'indice unico si
-- costruisce: su 300.000 corse poco più di un secondo.
-- ════════════════════════════════════════════════════════════════════════
DO $vincoli$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES ('ps_trips', 'CB-C'), ('ps_stops', 'CB-F'), ('ps_routes', 'CB-L')) AS x(tabella, sigla) LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I ALTER COLUMN codice SET DEFAULT (%L || pg_catalog.nextval(''public.ps_codici_seq''::pg_catalog.regclass)), ALTER COLUMN codice SET NOT NULL',
      t.tabella, t.sigla);
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conrelid = pg_catalog.to_regclass('public.' || t.tabella) AND conname = t.tabella || '_codice_valido') THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (codice = pg_catalog.btrim(codice) AND pg_catalog.char_length(codice) BETWEEN 1 AND 200 AND codice !~ ''[[:cntrl:]]'')',
        t.tabella, t.tabella || '_codice_valido');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conrelid = pg_catalog.to_regclass('public.' || t.tabella) AND conname = t.tabella || '_codice_del_progetto') THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (project_id, codice)',
                                t.tabella, t.tabella || '_codice_del_progetto');
    END IF;
  END LOOP;
END $vincoli$;
