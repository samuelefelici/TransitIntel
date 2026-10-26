-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 · Allinea la produzione a quello che il codice si aspetta
-- ───────────────────────────────────────────────────────────────────────────
-- Trovato con artifacts/api-server/scripts/crea-tutto.ts: sul database nato dal
-- baseline (cioè la produzione) si esegue tutto il DDL a runtime dell'API e si
-- confrontano i cataloghi (lib/db/scripts/catalogo.mjs). Qui c'è quello che il
-- codice crea, o vuole, e la produzione non ha ancora.
--
-- Come il baseline: ogni istruzione guarda prima il catalogo e, se è già a
-- posto, non tocca la tabella. Sulla produzione, la prima volta:
--  - ps_validity_units (tabella piccola) prende un lock ACCESS EXCLUSIVE fino
--    al commit della transazione del migratore, che arriva subito dopo;
--  - users (letta a ogni richiesta) prende lo stesso lock per il default, ma
--    lo aspetta al massimo 1 s: mentre aspetta, le letture di users si mettono
--    in coda dietro di lui. Se users è occupata, il default resta com'è con un
--    avviso nel log: conta solo per chi inserisce utenti a mano.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Urbana o extraurbana sull'Unità di Progettazione: decide il riposo minimo
--    fra due turni nel Roster (8h o 9h); NULL = vale la proposta dalle linee
--    (lib/udp-servizio.ts). La crea anche planning-studio-validity-units.ts al
--    primo uso delle unità; in produzione non c'era ancora, quindi la scelta
--    sull'unità non si poteva salvare.
DO $allinea$
BEGIN
  IF to_regclass('public.ps_validity_units') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_attribute
                      WHERE attrelid = to_regclass('public.ps_validity_units')
                        AND attname = 'service_type' AND NOT attisdropped) THEN
    ALTER TABLE public.ps_validity_units ADD COLUMN service_type text;
  END IF;
END
$allinea$;
--> statement-breakpoint
DO $allinea$
BEGIN
  IF to_regclass('public.ps_validity_units') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = to_regclass('public.ps_validity_units')
                        AND conname = 'ps_validity_units_service_type_check') THEN
    ALTER TABLE public.ps_validity_units ADD CONSTRAINT ps_validity_units_service_type_check
      CHECK (service_type IS NULL OR service_type IN ('urbano', 'extraurbano'));
  END IF;
END
$allinea$;
--> statement-breakpoint
-- 2. Il default dei permessi di un utente nuovo: tutte le 8 chiavi, Analisi
--    spenta, come lib/permessi.ts (PERMESSI_NUOVO_UTENTE) e la CREATE TABLE di
--    lib/auth.ts. La produzione aveva ancora quello di prima dei moduli
--    ('{"fares": true, "analytics": true, "scheduling": true}'): CREATE TABLE IF
--    NOT EXISTS non cambia una tabella che esiste. L'applicazione scrive sempre
--    i permessi per intero; il default conta per chi inserisce a mano.
--    Si confronta il valore, non il testo.
DO $allinea$
DECLARE
  atteso  constant jsonb := '{"analytics":false,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":false,"personale":false,"roster":false}';
  espr    text;
  attuale jsonb;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO espr
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = to_regclass('public.users') AND a.attname = 'permissions' AND NOT a.attisdropped;
  IF espr IS NOT NULL THEN
    EXECUTE format('SELECT (%s)::jsonb', espr) INTO attuale;
  END IF;
  IF attuale IS DISTINCT FROM atteso THEN
    PERFORM set_config('lock_timeout', '1s', true);
    BEGIN
      ALTER TABLE public.users ALTER COLUMN permissions SET DEFAULT
        '{"analytics":false,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":false,"personale":false,"roster":false}'::jsonb;
    EXCEPTION WHEN lock_not_available THEN
      RAISE WARNING '0001: users era occupata, il default dei permessi resta quello di prima (conta solo per chi inserisce utenti a mano)';
    END;
    PERFORM set_config('lock_timeout', '5s', true);
  END IF;
END
$allinea$;
