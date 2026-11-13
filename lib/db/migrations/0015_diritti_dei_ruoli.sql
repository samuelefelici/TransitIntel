-- ════════════════════════════════════════════════════════════════════════
-- 0015 — I diritti dei ruoli si cambiano dall'app (PR 2.18)
-- ────────────────────────────────────────────────────────────────────────
-- Che cosa dà ogni ruolo aziendale (lettura, scrittura o niente su ogni area)
-- era scritto solo nel codice: la matrice di lib/permessi. Da qui
-- l'amministratore la cambia da Amministrazione › Ruoli.
--
--   public.ruoli_diritti   una riga per ogni cella CAMBIATA rispetto alla
--                          matrice di partenza: ruolo, area, livello
--                          (N = niente, L = lettura, S = scrittura).
--
-- **Tabella vuota = matrice di partenza**: il giorno del rilascio nessuno
-- cambia accesso. L'API calcola i diritti con la matrice di partenza e sopra
-- queste righe; una cella riportata al valore di partenza torna a non avere
-- riga. Se un domani il codice aggiunge un'area, i ruoli la prendono dalla
-- matrice di partenza senza toccare questa tabella.
--
-- Niente elenco chiuso di ruoli e aree nei vincoli: sono nomi del codice, e
-- una riga con un nome che il codice non conosce più semplicemente non vale.
-- I vincoli fissano la forma e i tre livelli.
--
-- Il registro delle modifiche la sorveglia con i valori: è chi può fare che
-- cosa, come i ruoli degli utenti.
--
-- Lock: tabella nuova, nessuno la sta usando.
-- ════════════════════════════════════════════════════════════════════════
DO $ruoli$
BEGIN
  IF pg_catalog.to_regclass('public.ruoli_diritti') IS NULL THEN
    CREATE TABLE public.ruoli_diritti (
      ruolo          text NOT NULL CONSTRAINT ruoli_diritti_ruolo CHECK (ruolo ~ '^[a-z][a-z_]{0,39}$'),
      area           text NOT NULL CONSTRAINT ruoli_diritti_area CHECK (area ~ '^[a-z][a-z_]{0,39}$'),
      livello        text NOT NULL CONSTRAINT ruoli_diritti_livello CHECK (livello IN ('N', 'L', 'S')),
      aggiornata_il  timestamptz NOT NULL DEFAULT now(),
      -- chi l'ha salvata (users.id)
      aggiornata_da  uuid,
      CONSTRAINT ruoli_diritti_pkey PRIMARY KEY (ruolo, area)
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.ruoli_diritti OWNER TO cerbero_owner;
  END IF;
END $ruoli$;
--> statement-breakpoint
SELECT registro.sorveglia('public.ruoli_diritti', ARRAY['ruolo', 'area'], NULL, NULL, true, '{}', ARRAY['aggiornata_il']);
