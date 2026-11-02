-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 · La coda dei lavori: i calcoli lunghi sopravvivono a un deploy
-- ───────────────────────────────────────────────────────────────────────────
-- I calcoli lunghi (turni guida, e dalla PR 2.6 turni macchina e VCSP) non
-- vivono più nella memoria dell'API: l'API scrive qui una riga, il lavoratore
-- (o l'esecutore interno dell'API) la prende, esegue e scrive l'esito. Un
-- deploy o un riavvio non perde niente: un lavoro preso da un processo che
-- muore torna in coda quando scade il suo lease (artifacts/api-server/src/lib/
-- lavori/coda.ts).
--
-- Schema a parte: argos_ro non lo vede (il suo contratto è un elenco chiuso di
-- tabelle in public e caronte), e PUBLIC non ha niente. La tabella dice chi ha
-- lanciato quale calcolo: la leggono solo il proprietario del lavoro e l'admin,
-- e la pulizia (coda.ts, pulisci) toglie i risultati dopo 7 giorni e le righe
-- dopo 30.
--
-- Oggetti nuovi in uno schema nuovo: nessun lock su tabelle esistenti, e il
-- codice di prima non li usa.
-- ═══════════════════════════════════════════════════════════════════════════
DO $coda$
BEGIN
  IF to_regnamespace('coda') IS NULL THEN
    CREATE SCHEMA coda;
  END IF;
END
$coda$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA coda FROM PUBLIC;
--> statement-breakpoint
DO $coda$
BEGIN
  IF to_regclass('coda.lavori') IS NULL THEN
    CREATE TABLE coda.lavori (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- che cosa: 'python' (uno degli script consentiti, artifacts/api-server/src/lib/lavori/python.ts);
      -- gli altri tipi arrivano con le PR 2.6 e 2.7
      tipo            text NOT NULL CONSTRAINT lavori_tipo CHECK (tipo IN ('python', 'ottimizza_veicoli', 'giro_agente', 'materializza_feed')),
      -- la forma della richiesta: un processo prende solo le versioni che conosce
      versione        smallint NOT NULL DEFAULT 1,
      -- veloce (fino a 2 minuti) o lunga: slot separati, così un calcolo lungo non ferma i brevi
      corsia          text NOT NULL CONSTRAINT lavori_corsia CHECK (corsia IN ('veloce', 'lunga')),
      stato           text NOT NULL DEFAULT 'in_coda'
                      CONSTRAINT lavori_stato CHECK (stato IN ('in_coda', 'in_corso', 'completato', 'fallito', 'fermato')),
      -- chi l'ha lanciato e da dove ('api', 'argos'…): niente FK, la storia non blocca la cancellazione di un utente
      utente_id       uuid,
      via             text,
      -- l'oggetto su cui lavora (uno scenario…) e, se serve, una chiave che vieta due lavori vivi uguali
      oggetto_id      uuid,
      chiave_unicita  text,
      richiesta       jsonb NOT NULL,
      metadati        jsonb NOT NULL DEFAULT '{}'::jsonb,
      avanzamento     jsonb,
      http_codice     smallint,
      risultato       jsonb,
      errore          text,
      -- calcolo: l'ha detto il calcolo (non si ritenta); interrotto: il processo è morto;
      -- scaduto: ha superato timeout_sec; annullato: fermato da chi l'ha lanciato; sistema: altro
      errore_tipo     text CONSTRAINT lavori_errore_tipo CHECK (errore_tipo IN ('calcolo', 'interrotto', 'scaduto', 'annullato', 'sistema')),
      tentativi       smallint NOT NULL DEFAULT 0,
      max_tentativi   smallint NOT NULL DEFAULT 2,
      timeout_sec     integer NOT NULL CONSTRAINT lavori_timeout CHECK (timeout_sec BETWEEN 10 AND 7200),
      disponibile_dal timestamptz NOT NULL DEFAULT now(),
      -- il lease: chi lo sta eseguendo, l'ultimo battito, quando scade se il battito si ferma
      preso_da        text,
      battito_il      timestamptz,
      scade_il        timestamptz,
      annulla         boolean NOT NULL DEFAULT false,
      creato_il       timestamptz NOT NULL DEFAULT now(),
      iniziato_il     timestamptz,
      finito_il       timestamptz,
      aggiornato_il   timestamptz NOT NULL DEFAULT now()
    );
  END IF;
END
$coda$;
--> statement-breakpoint
DO $coda$
BEGIN
  -- i lavori da prendere, per corsia e in ordine di arrivo
  IF to_regclass('coda.lavori_da_prendere') IS NULL THEN
    CREATE INDEX lavori_da_prendere ON coda.lavori (corsia, creato_il) WHERE stato = 'in_coda';
  END IF;
  -- i lease da controllare
  IF to_regclass('coda.lavori_scadenza') IS NULL THEN
    CREATE INDEX lavori_scadenza ON coda.lavori (scade_il) WHERE stato = 'in_corso';
  END IF;
  -- i lavori di una persona, i più recenti prima
  IF to_regclass('coda.lavori_utente') IS NULL THEN
    CREATE INDEX lavori_utente ON coda.lavori (utente_id, creato_il DESC);
  END IF;
  -- la pulizia
  IF to_regclass('coda.lavori_finiti') IS NULL THEN
    CREATE INDEX lavori_finiti ON coda.lavori (finito_il) WHERE finito_il IS NOT NULL;
  END IF;
  -- al più un lavoro vivo per chiave (per esempio un giro di Argos per progetto)
  IF to_regclass('coda.lavori_unici_vivi') IS NULL THEN
    CREATE UNIQUE INDEX lavori_unici_vivi ON coda.lavori (chiave_unicita)
      WHERE stato IN ('in_coda', 'in_corso') AND chiave_unicita IS NOT NULL;
  END IF;
END
$coda$;
