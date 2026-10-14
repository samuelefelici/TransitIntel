-- ═══════════════════════════════════════════════════════════════════════════
-- Roster: riposi fra i turni e Unità di Progettazione urbane o extraurbane
-- ───────────────────────────────────────────────────────────────────────────
-- Fra due turni dello stesso conducente servono 8h se urbani, 9h se uno è
-- extraurbano, e due turni non si sovrappongono. Il roster avvisa e si può
-- forzare: l'assegnazione forzata resta segnata (chi, quando, quali regole).
--
-- Urbana o extraurbana si sceglie sull'Unità di Progettazione; NULL = vale la
-- proposta fatta dalle linee delle sue corse.
--
-- L'applicazione aggiunge colonne e indice da sé al primo avvio
-- (api-server/src/lib/anagrafica-store.ts e planning-studio-validity-units.ts);
-- il file serve a chi preferisce applicarli prima, e a lasciarne traccia.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE roster_assignments ADD COLUMN IF NOT EXISTS forzatura jsonb;
CREATE INDEX IF NOT EXISTS idx_roster_assign_driver_day ON roster_assignments(driver_id, day);

DO $$ BEGIN
  IF to_regclass('ps_validity_units') IS NOT NULL THEN
    ALTER TABLE ps_validity_units ADD COLUMN IF NOT EXISTS service_type text;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ps_validity_units_service_type_check') THEN
      ALTER TABLE ps_validity_units ADD CONSTRAINT ps_validity_units_service_type_check
        CHECK (service_type IS NULL OR service_type IN ('urbano', 'extraurbano'));
    END IF;
  END IF;
END $$;
