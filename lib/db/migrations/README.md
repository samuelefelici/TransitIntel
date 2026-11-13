# Migrazioni del database di Cerbero

Lo schema di Cerbero (schemi `public`, `caronte` e `coda`) cambia **solo** da qui. Le
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
  produzione, migrati, ci arrivino tutti e due. Descrive solo gli oggetti di
  Cerbero: quelli delle estensioni (PostGIS in produzione) ne restano fuori.

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
- **Una chiave esterna su una tabella che ha già righe** (0010 e 0011): prima
  il vincolo `NOT VALID` (da subito niente righe nuove senza padre, e nessuna
  lettura della tabella), poi la pulizia delle righe orfane come
  `cerbero_owner`, che chiude il file; la convalida (`VALIDATE CONSTRAINT`) in
  un secondo file, perché è DDL e come `cerbero_owner` non passa. Si tolgono
  solo le righe che nessuna richiesta può più leggere, e quante sono si scrive
  nel log con un `RAISE WARNING`. Se togliere una riga cambia quello che l'app
  calcola, non lo decide la migrazione: in quel caso (0013, la categoria delle
  corse) la migrazione guarda prima, e se trova righe senza padre **non mette
  il vincolo e non fallisce**: lo scrive nel log con un `RAISE WARNING`, e il
  vincolo si mette a mano dopo aver sistemato i dati dall'app (il comando sta
  in DEPLOY). Va bene solo se l'app funziona uguale con e senza il vincolo, e
  se un test prova tutti e due i casi
  (`lib/db/tests/chiave-categoria-rimandata.test.sql`). «Guarda prima» vuol
  dire con il lucchetto già preso (`LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE`
  prima del conteggio): mentre il deploy migra il container di prima serve
  ancora, e una riga scritta fra il conteggio e l'`ALTER` farebbe fallire la
  migrazione (`lib/db/tests/chiave-categoria-in-gara.sh`).
- **Mai modificare una migrazione rilasciata**: il migratore si ferma e la CI
  fallisce. Se serve correggere, una migrazione nuova.
- **Chi possiede cosa (PR 2.8).** Le tabelle, le viste e le sequenze di
  Cerbero sono di `cerbero_owner` (NOLOGIN); l'app si collega come
  `cerbero_app`, che lavora come `cerbero_owner`. Gli schemi e tutto
  `cerbero_migrazioni` restano di chi migra (`postgres`). Ruoli, diritti e
  proprietari li tiene in ordine il migratore a ogni avvio, dopo le migrazioni
  (`lib/db/scripts/ruoli-regole.mjs`; a mano `node lib/db/scripts/ruoli.mjs`).
  Il migratore è un superutente: una migrazione gira **come postgres**, quindi:
  - ogni oggetto nuovo (CREATE TABLE, VIEW, SEQUENCE, MATERIALIZED VIEW, e la
    vista `ps_variants` ricreata) passa subito a `cerbero_owner`, nello stesso
    blocco e guardato dall'esistenza del ruolo:
    `IF to_regrole('cerbero_owner') IS NOT NULL THEN ALTER TABLE public.t OWNER TO cerbero_owner; END IF;`.
    Altrimenti, dal commit della migrazione al riallineamento, l'app non lo
    vede (lo controlla un test in `migrazioni.test.ts` dalla 0006 in poi);
  - i dati delle tabelle di Cerbero (UPDATE, INSERT, DELETE) si toccano come
    `cerbero_owner`: le tabelle sono sue, e un default o un vincolo messi lì
    dall'app non devono girare come superutente. Si torna a chi migra prima
    della fine, perché drizzle registra la migrazione nella stessa transazione
    (in `cerbero_migrazioni`, che `cerbero_owner` non scrive):
    ```sql
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid = pg_catalog.to_regclass('public.t')
                    AND c.relowner = pg_catalog.to_regrole('cerbero_owner')) THEN
        EXECUTE 'SET LOCAL ROLE cerbero_owner';
      END IF;
    END $$;
    --> statement-breakpoint
    UPDATE public.t SET …;
    --> statement-breakpoint
    RESET ROLE;
    ```
    La guardia guarda di chi è la tabella, non solo se il ruolo esiste: su un
    database appena creato in un cluster che ha già i ruoli (un secondo
    database, un ripristino) le tabelle sono ancora di chi migra fino al
    riallineamento, e passare a `cerbero_owner` darebbe «permission denied».
    `RESET ROLE` è l'ultima istruzione del file (0009);
    Come `cerbero_owner` il DDL è fermato dall'event trigger
    `cerbero_ddl_dell_app`, tutto (dalla 2.16b anche `CREATE TABLE` e
    `ALTER TABLE`): lì dentro solo dati. Il DDL di una migrazione si esegue da
    migratore, prima o dopo quel blocco;
  - nomi sempre qualificati (`public.t`, `pg_catalog.lower`): il migratore gira
    con `search_path = pg_catalog, pg_temp`, e un nome senza schema non trova
    le tabelle.
- **L'app non esegue DDL (event trigger `cerbero_ddl_dell_app`, PR 2.16b).**
  Come `cerbero_app` o `cerbero_owner` ogni comando che crea, altera o toglie
  un oggetto si ferma con 42501: tabelle (anche temporanee), indici, colonne,
  funzioni, viste, trigger, permessi. Fino alla 2.16a passavano i comandi
  delle unità pigre (`CREATE TABLE`, `CREATE TABLE AS`, `CREATE INDEX`,
  `ALTER TABLE`), e `cerbero_owner` aveva CREATE su `public`, `caronte` e
  `coda`: ora no. Lo crea e lo tiene acceso il migratore; API e lavoratore non
  partono senza. Unica eccezione: dentro le funzioni del registro delle
  modifiche (di `cerbero_registro`) passano `CREATE TABLE` e `ALTER TABLE`,
  per la partizione del mese. Una funzione nuova del registro che avesse
  bisogno di altro DDL va aggiunta a `COMANDI_DEL_REGISTRO`
  (`lib/db/scripts/ruoli-regole.mjs`), e va guardata.
- **Funzioni nei default, nei vincoli e negli indici.** Un default, un CHECK,
  una colonna generata o un indice con un'espressione possono usare solo le
  funzioni di `FUNZIONI_AMMESSE` (`lib/db/scripts/ruoli-regole.mjs`), oltre a
  quelle degli operatori e delle conversioni di sistema: le esegue chi scrive
  la riga, a volte un superutente. Lo stesso per i tipi delle colonne e delle
  conversioni: domini solo di sistema, tipi con le funzioni di `pg_catalog` o
  di un'estensione (il CHECK di un dominio e l'input di un tipo girano come
  chi scrive). Sui comandi delle funzioni del registro lo fa rispettare il
  secondo event trigger (`cerbero_ddl_dell_app_fine`). Il migratore, prima di
  migrare, non parte se una tabella di Cerbero ne usa un'altra. Una
  migrazione che ne usa una nuova va guardata (niente SQL passato come testo,
  file, impostazioni, letture di altre tabelle) e la funzione si aggiunge
  all'elenco nella stessa PR: la CI la segnala (`ruoli.mjs --verifica` sulla
  copia della produzione).
- **Aggiornare PostGIS** (`ALTER EXTENSION postgis UPDATE`, come superutente,
  con `public` nel percorso): `cerbero_owner` non ha più CREATE su `public`
  (PR 2.16b), quindi non c'è niente da togliere prima. Se `ruoli.mjs
  --verifica` avvisa che un altro ruolo può creare in `public`, quello sì va
  tolto prima.
- **Codici stabili (PR 3.1, 0017 e 0018).** `ps_trips`, `ps_stops` e
  `ps_routes` hanno `codice`: obbligatorio, unico nel progetto, lo stesso
  nelle copie del programma. Una riga che non lo porta lo riceve dal default
  (`CB-C…`, `CB-F…`, `CB-L…`, dalla sequenza `ps_codici_seq`). Una migrazione
  che copia righe di queste tabelle dentro lo stesso progetto non copia il
  codice; una che le sposta fra progetti lo conserva. L'import scrive come
  codice l'id del file (`artifacts/api-server/src/lib/codici-stabili.ts`).
- **Il registro delle modifiche (PR 2.10 e 2.11).** Le tabelle sorvegliate hanno i
  trigger `registro_*`, che scrivono in `registro.modifiche` (schema, tabelle e
  funzioni di `cerbero_registro`, non di `cerbero_owner`). Una tabella nuova
  con programmi, orari, turni, tariffe, persone o permessi si sorveglia nella
  stessa migrazione che la crea:
  ```sql
  SELECT registro.sorveglia('public.t', ARRAY['id'], 'progetto_ps', 'project_id', true);
  ```
  Gli argomenti: chiave, tipo e colonna dell'ambito, `con_valori` (false per
  persone, roster e anagrafica), poi `valori_di` (le sole colonne con il
  valore, se `con_valori` è false), `escluse` (pattern LIKE delle colonne che
  non contano), `solo_nome` (colonne di cui va solo il nome) e, dalla 0007,
  `riepilogo_sempre` (true per le tabelle che l'app riscrive una riga per
  volta, come gli orari alle fermate: un riepilogo per transazione, mai una
  riga per record).
  - **Prima di sorvegliare una tabella si guarda come l'app la scrive.** Se
    la riscrive durante le letture (le tabelle della validità), il registro
    attribuirebbe modifiche a chi ha solo aperto una pagina: prima si sistema
    la scrittura. Se la scrive con migliaia di istruzioni da una riga, ogni
    istruzione paga il trigger (DEPLOY, «Quanto costa»).
  - Un **tipo di ambito nuovo** che non è una persona va aggiunto all'elenco
    degli ambiti che si possono fissare, in tre posti: `registro.leggi()` (una
    migrazione), `AMBITI_FILTRABILI` dell'API (`lib/registro-modifiche.ts`) e
    della SPA. Un ambito che è una persona non ci va mai.
  - L'app non legge le tabelle del registro: chiama `registro.leggi()` e
    `registro.stato()`. Un `FROM registro.<tabella>` nel codice dell'API fa
    fallire un test, e un GRANT in più lo toglie il migratore a ogni avvio
    (`DA_ESEGUIRE` in `ruoli-regole.mjs`).
  - Una **colonna nuova** con dati personali, sanitari o segreti in una
    tabella con i valori va in `escluse` o in `solo_nome` nella stessa
    migrazione: altrimenti il suo valore finisce nel registro. Per le colonne
    di testo lo ricorda un test (`migrazioni.test.ts`, «le colonne di testo
    sono tutte decise»). I riferimenti alle persone (`%user_id`, `added_by`,
    `created_by`) sono già «solo nome» in ogni tabella.
  - **`app_settings`** si registra col valore: niente segreti lì dentro (le
    chiavi stanno nelle variabili d'ambiente).
  - Una tabella sorvegliata **rinominata o cancellata**, o una colonna
    nominata da una regola rinominata: la regola si aggiorna nella stessa
    migrazione (`registro.sorveglia` col nome nuovo, `DELETE FROM
    registro.sorvegliate WHERE tabella = '…'` per la vecchia). Altrimenti
    `registro.verifica()` la segnala e `ruoli.mjs --verifica` fallisce.
  - L'app non può farlo da sé: `cerbero_ddl_dell_app_fine` le impedisce di
    spegnere i trigger, di rinominare o sostituire una tabella sorvegliata o
    le sue colonne e di legarla per ereditarietà o come partizione;
    `cerbero_ddl_dell_app_riscrive` (`table_rewrite`) di riscriverla
    (`ALTER COLUMN … TYPE … USING`, `SET EXPRESSION`).
- **Permessi**: niente GRANT nelle migrazioni per i ruoli in sola lettura.
  Argos legge solo le tabelle del suo contratto
  (`lib/db/contratti/argos-lettura.mjs`), che il migratore applica a ogni
  avvio dopo le migrazioni: una tabella nuova non è sua finché non entra nel
  contratto.
- **Funzioni SECURITY DEFINER**: ogni funzione nuova è eseguibile da tutti
  (PUBLIC), Argos compreso. Una SECURITY DEFINER gira coi diritti del suo
  proprietario, quindi va creata con `REVOKE EXECUTE ON FUNCTION … FROM
  PUBLIC` e data solo a chi serve: altrimenti il migratore lo segnala come
  errore a ogni avvio. Non va mai usata come funzione di un operatore o di un
  cast, come supporto di una classe di operatori, in un tipo o in un range, o
  in un aggregato: lì gira senza che si controlli l'EXECUTE di chi la usa. Né
  con un primo argomento `record` in uno schema dove Argos entra (un cast
  creato da lui la farebbe girare).
- **L'API non contiene DDL** (test `migrazioni.test.ts`, «l'API non cambia lo
  schema»). La PR 2.4 l'aveva tolto dall'avvio e dalle richieste; la 2.16a ha
  tolto le unità pigre (ensure…/assicura…) che creavano tabelle al primo uso.
  Una colonna o una tabella nuova si aggiunge qui, mai con un `IF NOT EXISTS`
  nel codice: il test fallisce, e il database lo rifiuta (PR 2.16b, anche per
  una tabella temporanea: per un insieme di lavoro si usa una CTE). Un passo
  sui dati (righe di default, sistemazioni) può stare nel codice; ciò che
  cambia la struttura no.
- **La vista `ps_variants`** è un alias di `ps_route_variants` con l'elenco
  delle sue colonne fissato alla creazione. Prima l'API la ricreava a ogni
  avvio; ora no: una migrazione che aggiunge colonne a `ps_route_variants`
  ricrea anche la vista (DROP e CREATE nello stesso blocco), se il codice le
  legge da lì.
- **Lo schema `coda`** (0004) contiene la coda dei lavori: la usano l'API e il
  lavoratore (`artifacts/api-server/src/lib/lavori/coda.ts`). Senza permessi a
  PUBLIC e fuori dal contratto di `argos_ro`; il catalogo atteso lo guarda.
- **Le richieste a Mizar** (0005, `caronte.avm_richieste_mizar`): accanto agli
  altri archivi AVM di Cerbero, fuori dal contratto di `argos_ro` (un test in
  `migrazioni.test.ts` lo controlla) e non concesse a `caronte_app`.
- **Per chi la verifica in due passaggi è obbligatoria** (0008,
  `users.mfa_obbligatoria`): una colonna calcolata (`GENERATED ALWAYS AS …
  STORED`) da `role` e `permissions`. È la regola: la leggono l'API e
  FleetCare, nessuno la riscrive. Per cambiarla, una migrazione con
  `ALTER TABLE public.users ALTER COLUMN mfa_obbligatoria SET EXPRESSION AS (…)`
  (Postgres 17; riscrive la tabella, che è piccola), con solo operatori e
  funzioni ammesse. Una colonna calcolata lega le colonne da cui dipende: non
  se ne cambia il tipo, e toglierle chiede `CASCADE`, che toglie anche lei.
  Che sia ancora calcolata, e come dice il catalogo, lo controlla
  `ruoli.mjs --verifica` (solo su un database alla stessa migrazione del
  codice): chi possiede la tabella può toglierle l'espressione.
- **L'API controlla di essere allineata** (`artifacts/api-server/src/lib/guardia-schema.ts`):
  conosce il diario della sua immagine (`lib/db/scripts/diario-incluso.mjs`,
  incorporato nel bundle) e, se al database manca una migrazione,
  `/api/healthz` risponde 503 con `schema: "indietro"`.
