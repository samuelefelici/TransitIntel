# Migrazioni del database di Cerbero

Lo schema di Cerbero (schemi `public` e `caronte`) cambia **solo** da qui. Le
migrazioni le applica l'API all'avvio (`docker/avvio.sh` →
`lib/db/scripts/migra.mjs`), con il migrator di drizzle: lo stesso strumento
di FleetCare, con lo schema di tracciamento `cerbero_migrazioni`.

- `0000_baseline.sql` è lo schema della produzione al 25/10/2026, generato da
  `lib/db/scripts/genera-baseline.mjs` a partire da
  `lib/db/schema-produzione/2026-10-25.sql`. Non si modifica a mano.
- `meta/_journal.json` è il diario: una voce per file, in ordine.
- `meta/impronte.json` fissa lo sha256 di ogni migrazione rilasciata.
- `meta/catalogo.json` è lo schema atteso dopo tutte le migrazioni (catalogo
  normalizzato): la CI controlla che un database vuoto e una copia della
  produzione, migrati, ci arrivino tutti e due.

## Aggiungere una migrazione

1. Crea `NNNN_cosa_fa.sql` con il numero successivo. SQL scritto a mano; le
   istruzioni separate da una riga `--> statement-breakpoint`.
2. Aggiungi la voce in `meta/_journal.json`: `idx` successivo, `"version": "7"`,
   `when` maggiore dell'ultimo (millisecondi), `tag` uguale al nome del file
   senza `.sql`, `"breakpoints": true`.
3. `pnpm --filter @workspace/db run impronte` registra l'impronta.
4. Aggiorna `meta/catalogo.json` (se cambia lo schema): su un database vuoto
   `DATABASE_URL=… pnpm --filter @workspace/db run migra`, poi
   `DATABASE_URL=… node lib/db/scripts/catalogo.mjs > lib/db/migrations/meta/catalogo.json`.
   Usa Postgres 17, come la produzione e la CI.
5. Provala anche su una copia della produzione: il dump di
   `lib/db/schema-produzione/` caricato in un database nuovo (togliendo la riga
   `CREATE SCHEMA public;`), poi `migra`, poi lo stesso catalogo.

**Finché la migrazione non è su main** la puoi ancora correggere: togli la sua
riga da `meta/impronte.json`, rilancia `impronte` e ricrea il database di
prova (il migratore ricorda l'impronta di quello che ha applicato). Una volta
su main non si tocca più.

## Regole

- **Compatibile col codice di prima.** Durante il deploy il container vecchio
  serve ancora: si aggiunge (tabelle, colonne nullable o con default, indici),
  non si toglie né si rinomina quello che il codice in esercizio usa. La
  pulizia va in una migrazione successiva, dopo un rilascio.
- **Guardata e idempotente** quando tocca oggetti che possono già esistere:
  controlla il catalogo (`to_regclass`, `pg_attribute`, `pg_constraint`) in un
  blocco `DO` invece di affidarti a `IF NOT EXISTS`, che su indici e colonne
  prende comunque un lock sulla tabella. Nelle condizioni usa
  `attrelid = to_regclass('public.t')`, non `'public.t'::regclass`: il
  secondo dà errore quando la tabella manca, prima ancora di valutare la
  condizione.
- **Tabelle molto lette** (`users`, `gtfs_*`): un `ALTER` prende un lock
  esclusivo e, mentre aspetta, le letture si mettono in coda dietro di lui.
  Per un cambio non essenziale usa un `lock_timeout` breve solo per quel
  comando, come fa la 0001.
- **Niente lock lunghi.** Tutte le migrazioni in sospeso girano in una sola
  transazione: niente `CREATE INDEX CONCURRENTLY` (non si può), niente
  riscritture di tabelle grandi. Il migratore aspetta al massimo 5 s una
  tabella occupata e poi riprova.
- **Brevi.** All'avvio, migrazioni e partenza dell'API devono stare in circa
  un minuto e mezzo: oltre, l'healthcheck di Coolify annulla il deploy (nel log
  `[migrazioni] SIGTERM`, non `FALLITA`) e resta il container vecchio. La CI
  non se ne accorge, perché prova su database senza dati. Un backfill su una
  tabella grande va in uno script a parte, lanciato fuori dal deploy.
- **Mai modificare una migrazione rilasciata**: il migratore si ferma e la CI
  fallisce. Se serve correggere, una migrazione nuova.
- **Permessi**: nessuna tabella nuova con dati personali in `public` senza
  pensare ai ruoli in sola lettura (Argos): i permessi di default di `postgres`
  in `public` la renderebbero leggibile.
- **Il DDL dentro l'API non cresce più** (test `migrazioni.test.ts`, «il DDL a
  runtime può solo scendere»).
