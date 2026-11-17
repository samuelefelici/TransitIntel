-- ════════════════════════════════════════════════════════════════════════
-- 0037 — Dati aperti: i file pubblicati a un indirizzo stabile (tappa 6.3)
-- ────────────────────────────────────────────────────────────────────────
-- Il NAP non riceve file a mano: scarica ogni giorno da un indirizzo che non
-- cambia. Qui stanno i due file che Cerbero pubblica (il GTFS consegnabile e
-- il NeTEx del profilo italiano), già pronti: li prepara il lavoratore dalla
-- versione in esercizio, e chi scarica riceve i byte così come sono.
--   azienda.dati_aperti_attivi   l'interruttore: nasce spento, lo accende
--                                l'amministratore (resta nel registro, con
--                                il resto dell'azienda);
--   dati_aperti                  una riga per file. Il file in linea è
--                                l'ultimo buono; accanto, l'esito dell'ultimo
--                                tentativo di prepararlo, che può essere
--                                andato male senza togliere il file di prima.
-- La tabella la scrive il sistema, non una persona: non è nel registro.
-- ════════════════════════════════════════════════════════════════════════
DO $dati$
BEGIN
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS dati_aperti_attivi boolean NOT NULL DEFAULT false;
  IF pg_catalog.to_regclass('public.dati_aperti') IS NULL THEN
    CREATE TABLE public.dati_aperti (
      tipo              text PRIMARY KEY CONSTRAINT dati_aperti_tipo CHECK (tipo IN ('gtfs', 'netex')),
      -- il file in linea
      contenuto         bytea,
      impronta          text CONSTRAINT dati_aperti_impronta CHECK (impronta ~ '^[0-9a-f]{64}$'),
      byte              integer CONSTRAINT dati_aperti_byte CHECK (byte BETWEEN 1 AND 268435456),
      versione_id       uuid,
      in_esercizio_dal  timestamptz,
      preparato_il      timestamptz,
      conteggi          jsonb,
      -- l'ultimo tentativo: di che cosa (la firma di versione, azienda e formato) e com'è andato
      firma             text CONSTRAINT dati_aperti_firma CHECK (firma ~ '^[0-9a-f]{64}$'),
      provato_il        timestamptz,
      esito             text CONSTRAINT dati_aperti_esito CHECK (esito IN
                          ('pubblicato', 'gtfs_con_errori', 'non_valido', 'senza_xmllint', 'senza_codice', 'senza_versione', 'errore')),
      messaggio         text CONSTRAINT dati_aperti_messaggio CHECK (char_length(messaggio) <= 2000),
      dettagli          jsonb,
      CONSTRAINT dati_aperti_file_intero CHECK (
        (contenuto IS NULL) = (impronta IS NULL) AND (contenuto IS NULL) = (byte IS NULL)
        AND (contenuto IS NULL) = (preparato_il IS NULL))
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.dati_aperti OWNER TO cerbero_owner;
  END IF;
END $dati$;
