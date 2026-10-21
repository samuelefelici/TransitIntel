-- ═══════════════════════════════════════════════════════════════════════════
-- Analisi spenta per i nuovi utenti (Fase 1, menu sul ciclo di lavoro)
-- ───────────────────────────────────────────────────────────────────────────
-- Il permesso «analytics» diventa la sezione Analisi del menu (mappa del
-- territorio, traffico, domanda, linee GTFS, ipotesi di linea, dati GTFS) e
-- un utente nuovo parte senza. Gli utenti che ci sono non cambiano: chi
-- l'aveva la tiene finché l'admin non la toglie. Le letture che servono anche
-- agli altri moduli non dipendono più da questo permesso
-- (api-server/src/lib/auth.ts, LETTURE_CONDIVISE).
--
-- L'applicazione scrive sempre i permessi per intero alla creazione di un
-- utente (lib/permessi.ts); il default della colonna serve a chi inserisce a
-- mano, e a lasciarne traccia.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE users ALTER COLUMN permissions SET DEFAULT
  '{"analytics":false,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":false,"personale":false,"roster":false}'::jsonb;
