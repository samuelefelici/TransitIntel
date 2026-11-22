-- ══════════════════════════════════════════════════════════════════════
-- 0061 — La rotazione dei turni: la tabella dei posti di un gruppo (tappa 7.8)
-- ──────────────────────────────────────────────────────────────────────
-- I conducenti di un deposito stanno in gruppi di rotazione
-- (roster_gruppi_turni), ognuno con la sua posizione (roster_drivers.
-- rotazione_turni_posizione). Un gruppo ha N posti; ogni posto dice quale
-- turno guida si fa nei giorni feriali, il sabato e la domenica (o festivo),
-- per esempio «posto 3: T04 dal lunedì al venerdì, T18 il sabato». A ogni
-- cambio di periodo (la cadenza del deposito: ogni settimana, o il 1° e il
-- 16 del mese) ogni conducente passa al posto successivo; la data di
-- riferimento del gruppo è il periodo in cui la posizione 1 è sul posto 1.
--
-- Il codice del turno è testo: quello dei turni guida pubblicati. Se un
-- programma nuovo cambia i codici, la tabella si aggiorna; un codice che quel
-- giorno non è pubblicato non si assegna e lo si dice.
-- ══════════════════════════════════════════════════════════════════════
DO $posti$
BEGIN
  IF pg_catalog.to_regclass('public.roster_rotazioni_turni_posti') IS NULL THEN
    CREATE TABLE public.roster_rotazioni_turni_posti (
      gruppo_id  uuid NOT NULL REFERENCES public.roster_gruppi_turni (id) ON DELETE CASCADE,
      posto      smallint NOT NULL CONSTRAINT roster_rotazioni_turni_posti_posto CHECK (posto BETWEEN 1 AND 500),
      feriale    text CONSTRAINT roster_rotazioni_turni_posti_feriale CHECK (feriale IS NULL OR char_length(feriale) BETWEEN 1 AND 40),
      sabato     text CONSTRAINT roster_rotazioni_turni_posti_sabato CHECK (sabato IS NULL OR char_length(sabato) BETWEEN 1 AND 40),
      domenica   text CONSTRAINT roster_rotazioni_turni_posti_domenica CHECK (domenica IS NULL OR char_length(domenica) BETWEEN 1 AND 40),
      CONSTRAINT roster_rotazioni_turni_posti_pkey PRIMARY KEY (gruppo_id, posto)
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.roster_rotazioni_turni_posti OWNER TO cerbero_owner;
  END IF;
END $posti$;
--> statement-breakpoint
SELECT registro.sorveglia('public.roster_rotazioni_turni_posti', ARRAY['gruppo_id', 'posto'], NULL, NULL, true, '{}', '{}', '{}');
