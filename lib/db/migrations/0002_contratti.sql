-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 · Contratti dei permessi: quale versione è in vigore
-- ───────────────────────────────────────────────────────────────────────────
-- Il migratore riporta i permessi di argos_ro al contratto di lettura
-- (lib/db/contratti/argos-lettura.mjs). Qui ricorda la versione applicata: se
-- parte un'immagine più vecchia (rollback), vale il contratto più nuovo e ad
-- Argos non vengono tolte le tabelle che la release successiva gli ha dato.
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
      aggiornato_il timestamptz NOT NULL DEFAULT now()
    );
  END IF;
END
$contratti$;
