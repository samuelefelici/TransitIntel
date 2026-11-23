-- ════════════════════════════════════════════════════════════════════════
-- 0067 — I punti di riposo dei turni guida, dato dell'azienda (tappa 7.22)
-- ────────────────────────────────────────────────────────────────────────
-- Dove il conducente fa la pausa di un turno a due riprese fuori residenza
-- (la sosta inoperosa dell'extraurbano), il calcolo dei turni guida conta
-- retribuita una parte della sosta: di più se il luogo non ha servizi. Finora
-- quei luoghi erano solo i «nodi di sosta» di un progetto di Planning Studio,
-- e il calcolo li trovava solo se il progetto dei turni era collegato a quel
-- progetto: ogni progetto li doveva riscrivere, e senza collegamento non ce
-- n'era nessuno. Qui diventano un dato dell'azienda, che vale per tutti i
-- calcoli:
--   punti_riposo  nome, se ha servizi (bagno, sala d'attesa), i nomi delle
--                 fermate del luogo (il calcolo le riconosce dal nome, come
--                 i nodi di sosta) e una nota.
-- I nodi di sosta dei progetti restano e valgono in più: per una fermata che
-- sta in tutti e due, vale quello del progetto.
-- Un'installazione nuova parte vuota.
-- ════════════════════════════════════════════════════════════════════════
DO $punti$
BEGIN
  IF pg_catalog.to_regclass('public.punti_riposo') IS NULL THEN
    CREATE TABLE public.punti_riposo (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nome          text NOT NULL CONSTRAINT punti_riposo_nome
                      CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120 AND nome !~ '[[:cntrl:]]'),
      con_servizi   boolean NOT NULL DEFAULT false,
      -- i nomi delle fermate del luogo, come li scrive il GTFS (il calcolo li confronta in maiuscolo);
      -- al più 50: senza funzioni nel vincolo (ruoli-regole.mjs, FUNZIONI_AMMESSE)
      fermate       text[] NOT NULL DEFAULT '{}'::text[] CONSTRAINT punti_riposo_fermate CHECK (fermate[51] IS NULL),
      nota          text NOT NULL DEFAULT '' CONSTRAINT punti_riposo_nota CHECK (char_length(nota) <= 300 AND nota !~ '[[:cntrl:]]'),
      aggiornato_il timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT punti_riposo_nome_unico UNIQUE (nome)
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.punti_riposo OWNER TO cerbero_owner;
  END IF;
END $punti$;
--> statement-breakpoint
SELECT registro.sorveglia('public.punti_riposo', ARRAY['id'], NULL, NULL, true, '{}', ARRAY['aggiornato_il']);
