-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 · Permessi degli utenti: tutte le chiavi, network con scheduling
-- ───────────────────────────────────────────────────────────────────────────
-- Fino alla PR 2.4 queste 6 UPDATE giravano a ogni avvio dell'API
-- (lib/auth.ts). Completano i permessi degli utenti nati prima di un modulo,
-- una volta sola: l'applicazione scrive sempre tutte le 8 chiavi (Gestione
-- Utenti con lib/permessi.ts normalizzaPermessi, il primo admin) e network
-- porta con sé scheduling. Un utente inserito a mano prende il default della
-- colonna, che la 0001 porta a 8 chiavi (se users era occupata in quel
-- momento il default è rimasto quello vecchio, con un avviso nel log): chi
-- inserisce a mano scriva le chiavi. Stesse istruzioni, stesso ordine: dove
-- le chiavi ci sono già non cambiano niente.
--
-- Solo dati, nessun lock sulla tabella: righe di users, e solo quelle a cui
-- manca qualcosa. Il codice di prima, che le rifà al suo avvio, non trova
-- niente da fare.
-- ═══════════════════════════════════════════════════════════════════════════
DO $permessi$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RETURN;
  END IF;

  -- Rete e orari: chi c'era prima del modulo lo riceve (aveva già i Turni)
  UPDATE public.users SET permissions = permissions || '{"network":true}'::jsonb
   WHERE NOT (permissions ? 'network');

  -- Rete e orari porta con sé i Turni: il server lo impone al salvataggio, chi
  -- è stato salvato prima (o ha ricevuto network qui sopra) poteva non averli
  UPDATE public.users SET permissions = permissions || '{"scheduling":true}'::jsonb
   WHERE coalesce((permissions->>'network')::boolean, false)
     AND NOT coalesce((permissions->>'scheduling')::boolean, false);

  -- FleetCare: abilitazione esplicita
  UPDATE public.users SET permissions = permissions || '{"fleetcare":false}'::jsonb
   WHERE NOT (permissions ? 'fleetcare');

  -- Esercizio (Mappa live, AVM): chi c'era eredita Analisi, sotto cui vivevano
  UPDATE public.users SET permissions = permissions
         || jsonb_build_object('centrale', coalesce((permissions->>'analytics')::boolean, true))
   WHERE NOT (permissions ? 'centrale');

  -- Personale: dati personali e di busta paga, abilitazione esplicita
  UPDATE public.users SET permissions = permissions || '{"personale":false}'::jsonb
   WHERE NOT (permissions ? 'personale');

  -- Roster: chi c'era eredita i Turni, sotto cui viveva
  UPDATE public.users SET permissions = permissions
         || jsonb_build_object('roster', coalesce((permissions->>'scheduling')::boolean, true))
   WHERE NOT (permissions ? 'roster');
END
$permessi$;
