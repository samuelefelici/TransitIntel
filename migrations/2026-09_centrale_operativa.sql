-- ═══════════════════════════════════════════════════════════════════════════
-- Modulo Centrale Operativa: la chiave "centrale" nei permessi utente
-- ───────────────────────────────────────────────────────────────────────────
-- I permessi di Cerbero sono un jsonb di booleani per utente, una chiave per
-- modulo (users.permissions). La Centrale Operativa raccoglie la Mappa live
-- del servizio (/operations) e il diario degli apparati AVM (/avm), che fino
-- a oggi stavano sotto "analytics".
--
-- Chi esiste già EREDITA il valore di "analytics": il rilascio del modulo
-- non deve togliere a nessuno una pagina che vedeva. I nuovi utenti nascono
-- con "centrale": false e l'admin lo accende dalla Gestione Utenti, come per
-- FleetCare.
--
-- L'applicazione esegue questo stesso aggiornamento da sé al primo avvio
-- (ensureUsersTable in api-server/src/lib/auth.ts): il file serve a chi
-- preferisce applicarlo prima, e a lasciarne traccia nel repository.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE users
   SET permissions = permissions
       || jsonb_build_object('centrale', coalesce((permissions->>'analytics')::boolean, true))
 WHERE NOT (permissions ? 'centrale');

ALTER TABLE users
  ALTER COLUMN permissions
  SET DEFAULT '{"analytics":true,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":false}'::jsonb;
