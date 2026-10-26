-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 · Contratti dei permessi: quale versione è in vigore, e chi l'ha scritta
-- ───────────────────────────────────────────────────────────────────────────
-- Il migratore riporta i permessi di argos_ro al contratto di lettura
-- (lib/db/contratti/argos-lettura.mjs). Qui ricorda la versione applicata: se
-- parte un'immagine più vecchia (rollback), vale il contratto più nuovo e ad
-- Argos non vengono tolte le tabelle che la release successiva gli ha dato.
--
-- Chi scrive qui decide i permessi di argos_ro, quindi il trigger annota
-- sempre l'utente collegato (session_user, che solo un superutente può
-- cambiare): il migratore usa un contratto salvato solo se l'ha scritto lui o
-- un superutente.
--
-- Tabella nuova nello schema del migratore: niente lock su tabelle esistenti,
-- e il codice di prima non la usa.
-- ═══════════════════════════════════════════════════════════════════════════
DO $contratti$
BEGIN
  IF to_regclass('cerbero_migrazioni.contratti') IS NULL THEN
    CREATE TABLE cerbero_migrazioni.contratti (
      nome          text PRIMARY KEY,
      versione      integer NOT NULL CHECK (versione > 0),
      elenco        text[] NOT NULL,
      aggiornato_il timestamptz NOT NULL DEFAULT now(),
      scritto_da    text NOT NULL DEFAULT session_user
    );
  END IF;
END
$contratti$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cerbero_migrazioni.contratti_chi_scrive() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $funzione$
BEGIN
  NEW.scritto_da := session_user;
  NEW.aggiornato_il := now();
  RETURN NEW;
END
$funzione$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION cerbero_migrazioni.contratti_chi_scrive() FROM PUBLIC;
--> statement-breakpoint
DO $trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'cerbero_migrazioni.contratti'::regclass AND tgname = 'contratti_chi_scrive') THEN
    CREATE TRIGGER contratti_chi_scrive BEFORE INSERT OR UPDATE ON cerbero_migrazioni.contratti
      FOR EACH ROW EXECUTE FUNCTION cerbero_migrazioni.contratti_chi_scrive();
  END IF;
END
$trigger$;
