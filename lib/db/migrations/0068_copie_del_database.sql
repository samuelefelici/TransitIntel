-- ════════════════════════════════════════════════════════════════════════
-- 0068 — Le copie del database fuori dal server (tappa 7.23)
-- ────────────────────────────────────────────────────────────────────────
-- Ogni notte il lavoratore fa una copia del database (pg_dump), la cifra con
-- la chiave pubblica dell'azienda e la carica in uno storage S3 fuori dal
-- server; poi la riscarica e controlla che sia quella (byte e SHA-256).
-- Qui c'è l'esito di ogni copia, e le copie chieste a mano dall'amministratore:
--   backup_copie  stato (chiesta, in_corso, riuscita, fallita, interrotta),
--                 chi l'ha chiesta (NULL: quella della notte), quando, il nome
--                 della copia nello storage, byte, SHA-256 del file cifrato,
--                 quante voci e quante tabelle con dati, la versione di
--                 pg_dump, le tabelle saltate perché cerbero_backup non le
--                 legge (un avanzo fatto a mano da un superutente), l'errore.
-- Una chiesta e una in corso alla volta (indice unico parziale): due
-- lavoratori, o due clic, non fanno due copie insieme.
-- Non è sotto registro: è lo stato di un lavoro del sistema, non un dato di
-- programmi, orari, turni, tariffe, persone o permessi.
-- ════════════════════════════════════════════════════════════════════════
DO $copie$
BEGIN
  IF pg_catalog.to_regclass('public.backup_copie') IS NULL THEN
    CREATE TABLE public.backup_copie (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      stato         text NOT NULL DEFAULT 'chiesta' CONSTRAINT backup_copie_stato
                      CHECK (stato IN ('chiesta', 'in_corso', 'riuscita', 'fallita', 'interrotta')),
      chiesta_da    uuid REFERENCES public.users(id) ON DELETE SET NULL,
      creata_il     timestamptz NOT NULL DEFAULT now(),
      iniziata_il   timestamptz,
      finita_il     timestamptz,
      oggetto       text CONSTRAINT backup_copie_oggetto CHECK (char_length(oggetto) <= 1024),
      byte          bigint CONSTRAINT backup_copie_byte CHECK (byte >= 0),
      sha256        text CONSTRAINT backup_copie_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      voci          integer,
      tabelle       integer,
      versione      text CONSTRAINT backup_copie_versione CHECK (char_length(versione) <= 200),
      escluse       text[] NOT NULL DEFAULT '{}'::text[],
      errore        text CONSTRAINT backup_copie_errore CHECK (char_length(errore) <= 2000)
    );
    CREATE UNIQUE INDEX backup_copie_una_per_stato ON public.backup_copie (stato) WHERE stato IN ('chiesta', 'in_corso');
    CREATE INDEX backup_copie_creata_il ON public.backup_copie (creata_il DESC);
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.backup_copie OWNER TO cerbero_owner;
  END IF;
END $copie$;
