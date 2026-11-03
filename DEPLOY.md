# 🚀 TransitIntel — Guida Deploy (Coolify, self-hosted)

## Architettura Produzione

```
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│  Web (Dockerfile.web)│────▶│  API (Dockerfile.api)│────▶│  PostgreSQL          │
│  React + Vite build  │     │  Express + Node 22   │     │  self-hosted         │
│  servito da nginx :80│     │  + Python (OR-Tools) │     │  (servizio Coolify)  │
│  su Coolify          │     │  :3000 su Coolify    │     │                      │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
```

Tutto gira su **Coolify** (self-hosted). Vercel/Render/Neon sono **legacy** e non più
usati: i file `vercel.json` (rimosso) e `render.yaml` appartengono alla vecchia
architettura e possono essere ignorati/eliminati.

I tre componenti sono tre **risorse Coolify** nello stesso progetto, così possono
parlarsi via rete interna:

| Componente | Sorgente build | Porta | Note |
|---|---|---|---|
| **Database** | immagine PostgreSQL di Coolify | 5432 | schema dalle migrazioni di `lib/db/migrations/`, applicate dall'API all'avvio |
| **API** | `Dockerfile.api` (repo) | 3000 | start: `sh docker/avvio.sh` (migrazioni, poi l'API) |
| **Web** | `Dockerfile.web` (repo) | 80 | nginx serve la SPA (`artifacts/transitintel/dist`) |

---

## STEP 1: Database — PostgreSQL su Coolify

1. Nel progetto Coolify: **+ New → Database → PostgreSQL** (versione 15+).
2. Scegli nome, utente e password; avvialo.
3. Annota l'**hostname interno** del servizio (Coolify lo espone agli altri
   servizi dello stesso progetto via rete privata) e l'eventuale **URL pubblico**.
4. **Lo schema non si applica a mano.** Lo crea e lo aggiorna il container
   dell'API all'avvio (`docker/avvio.sh`), con le migrazioni versionate di
   `lib/db/migrations/` (vedi «Migrazioni del database» qui sotto); in locale
   con `pnpm --filter @workspace/db run migra`. Su un database vuoto il primo avvio crea tutto lo
   schema della produzione; su uno che c'è già registra soltanto il punto di
   partenza (`0000_baseline`), senza toccare nessuna tabella.
   > `setup.sql` e gli specchi di `migrations/` non esistono più: lo schema
   > cambia solo con un file nuovo in `lib/db/migrations/`. `drizzle-kit push`
   > resta disattivato.
   > Opzionale, validatore Caronte: `caronte_setup.sql` crea il ruolo
   > `caronte_app` (vedi il file). Va eseguito **dopo il primo avvio dell'API**,
   > che crea lo schema `caronte`. Chi aveva eseguito la versione di prima deve
   > rieseguirlo: toglie la lettura di tutte le tabelle (utenti compresi) e
   > lascia solo le GTFS; poi cambia la password con `\password caronte_app`.

> ✅ Conserva la connection string. Forma tipica su rete interna Coolify (senza SSL):
> `postgres://user:password@<servizio-db>:5432/dbname`
> Se il DB è esposto pubblicamente con certificato self-signed, usa
> `?sslmode=no-verify` **oppure** imposta `PGSSL_NO_VERIFY=1` (vedi env).

---

### Migrazioni del database

Lo schema di Cerbero cambia **solo** con le migrazioni versionate di
`lib/db/migrations/`: file SQL numerati (`0000_baseline.sql`, `0001_…`) più il
diario `meta/_journal.json`, con lo stesso strumento di FleetCare (il
migrator di drizzle).

- **Quando girano.** All'avvio del container dell'API, prima del server
  (`docker/avvio.sh` → `lib/db/scripts/migra.mjs`). Nel log:
  `[migrazioni] 0001_allinea applicata` oppure `nessuna migrazione da applicare`.
- **Con quale utente.** `DATABASE_MIGRATOR_URL` se c'è, altrimenti
  `DATABASE_URL`: deve essere il proprietario delle tabelle (o un superutente),
  perché le migrazioni le modificano. Oggi sono lo stesso utente; si
  separeranno con i ruoli del database (Fase 2). `docker/avvio.sh` la toglie
  dall'ambiente dell'API e dei solver che lancia; resta però leggibile dentro
  il container, quindi le credenziali si separeranno davvero solo quando il
  migratore avrà un servizio suo.
- **Se una migrazione fallisce** il database non cambia (le migrazioni girano in
  una transazione) e **il container nuovo non parte**: nel log c'è
  `[migrazioni] FALLITA: <il motivo dato da Postgres>`, seguito dall'istruzione.
  Coolify tiene in servizio quello vecchio perché aspetta che il nuovo sia
  sano, con l'HEALTHCHECK dell'immagine: **vale solo con il rolling update**.
  Coolify lo disattiva, e ferma il vecchio prima di avviare il nuovo, se ci
  sono porte mappate sull'host, un nome di container fisso (o «Custom internal
  name»), `--ip`/`--ip6` nelle Custom Docker Options, o per i deploy delle PR:
  in quei casi una migrazione fallita lascia l'API spenta finché non si
  corregge. In Coolify, quindi:
  - **Application → Health check: lasciarlo spento.** Spento, Coolify usa
    l'HEALTHCHECK del Dockerfile (nel log del deploy: «Custom healthcheck
    found in Dockerfile»). Acceso di tipo URL, Coolify lo sostituisce con un
    controllo fatto con curl o wget, che nell'immagine non ci sono: il
    container nuovo non risulterebbe mai sano. In alternativa si può accendere
    di tipo «command» con `node docker/salute.mjs`.
  - Niente porte mappate sull'host, niente nome di container fisso, niente
    `--ip` nelle Custom Docker Options.
- **Quanto possono durare.** Coolify aspetta 20 s e poi controlla
  l'healthcheck 5 volte, una ogni 15 s: migrazioni e avvio dell'API devono
  stare in circa un minuto e mezzo. Oltre, Coolify annulla il deploy: nel log
  c'è `[migrazioni] SIGTERM: interrompo`, il database resta com'era e resta il
  container vecchio. Le operazioni lunghe sui dati non vanno in una
  migrazione (vedi il README delle migrazioni).
- **Avvisi.** Se una migrazione salta qualcosa che i dati non permettono (per
  esempio un indice unico con doppioni) il log lo dice con
  `[migrazioni] ATTENZIONE: …`: l'oggetto non verrà ricreato da solo.
- **Tracciamento.** Le migrazioni applicate stanno in
  `cerbero_migrazioni.__drizzle_migrations`, uno schema solo di Cerbero
  (`drizzle.__drizzle_migrations` è di FleetCare):
  ```sql
  SELECT id, created_at, left(hash, 12) FROM cerbero_migrazioni.__drizzle_migrations ORDER BY id;
  ```
- **Due container insieme** (deploy a rotazione) non migrano insieme: un
  lucchetto fa aspettare il secondo. Ogni comando aspetta al massimo 5 s una
  tabella occupata (`lock_timeout`), poi riprova; non resta in coda bloccando
  tutti.
- **Compatibilità.** Durante il deploy il container vecchio serve ancora: una
  migrazione aggiunge (tabelle, colonne con default, indici) e non toglie né
  rinomina quello che il codice di prima usa. La pulizia va in una migrazione
  successiva, dopo un rilascio.
- **Prima di un deploy con migrazioni**, un backup del database da Coolify.
- **Le migrazioni rilasciate non si modificano**: se ne scrive una nuova. Il
  migratore si ferma se un file già applicato è cambiato, e la CI lo controlla.
  Come scriverne una: `lib/db/migrations/README.md`.
- **L'API non tocca lo schema** (dalla PR 2.4): all'avvio e nelle richieste
  non esegue più `CREATE`/`ALTER`, quindi niente lock esclusivi su tabelle
  vive come `gtfs_trips` a ogni materializzazione. Restano, fino alla PR 2.16,
  le unità «pigre» che preparano una tabella al primo uso di una funzione
  (una volta per processo); un test (`migrazioni.test.ts`) impedisce che il
  DDL torni nell'avvio. Le chiavi mancanti nei permessi degli utenti, che
  prima si completavano a ogni avvio, le completa una volta sola la
  migrazione `0003_permessi_completi`.
- **Lo schema rispetto al codice.** All'avvio l'API confronta il tracciamento
  con le migrazioni della sua immagine, poi ricontrolla ogni 10 minuti (ogni
  15 secondi se qualcosa non va), e lo dice in `GET /api/healthz` (campo
  `schema`) e nel log:
  - `ok`: allineati;
  - `indietro`: mancano migrazioni. Nel log, a livello error, quali mancano.
    - **Un container appena partito** che non è mai stato allineato (API
      avviata senza il migratore, `DATABASE_MIGRATOR_URL` su un altro
      database): `/api/healthz` risponde **503**, l'HEALTHCHECK lo segna non
      sano e, nel deploy a rotazione, Coolify non gli manda traffico e tiene
      quello vecchio.
    - **Un container già in servizio** che trova il database indietro (un
      backup vecchio rimesso sotto): resta in servizio, con 200 e
      `"schema":"indietro"`. Non si spegne apposta: fuori dal deploy un
      container non sano esce dal routing di Traefik, e tutta l'API
      risponderebbe 404.
    - **Rimedio**: riavviare il container (l'avvio lancia il migratore e
      riparte allineato) oppure `node lib/db/scripts/migra.mjs` dal suo
      Terminal; in quel caso il controllo se ne accorge entro 15 secondi;
  - `avanti`: il database ha migrazioni più nuove del codice. È il container
    vecchio durante un deploy, o un rollback all'immagine precedente: va bene,
    perché le migrazioni restano compatibili all'indietro (nel log un avviso);
  - `sconosciuto`: il database non risponde (la prima sonda dopo l'avvio
    aspetta il primo controllo, al massimo 3 secondi). Resta 200, come prima.
- **L'indice unico delle email** (`users_email_normale_uq`: un'email, un
  utente, maiuscole e spazi non contano) lo crea la migrazione `0000_baseline`,
  che lo salta se in quel momento ci sono già utenti con la stessa email
  scritta in modi diversi. Finché manca, a ogni avvio il log dice «manca
  l'indice unico delle email». In produzione c'è. Se manca: si unificano gli
  utenti doppi da Gestione Utenti (quali sono:
  `SELECT lower(trim(email)), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;`),
  poi, da psql:
  ```sql
  CREATE UNIQUE INDEX CONCURRENTLY users_email_normale_uq ON users (lower(trim(email)));
  ```

### Argos: sola lettura su un elenco chiuso

Argos legge il database di Cerbero con il ruolo `argos_ro`, e solo le 23
tabelle che usa davvero: orari GTFS, Planning Studio, territorio e domanda,
nodi e matrice delle tariffe, Sala Operativa live. Niente utenti, accessi,
anagrafica, roster. L'elenco, il «contratto», è
`lib/db/contratti/argos-lettura.mjs`, con un numero di versione.

A ogni avvio dell'API il migratore riporta i permessi di `argos_ro` al
contratto:
- solo la lettura delle tabelle dell'elenco e l'USAGE dei loro schemi;
- niente scrittura (MAINTAIN compreso), sequenze, permessi su colonne o grant
  option;
- niente funzioni, large object, server esterni e parametri del server, né
  permessi negli altri schemi dello stesso database (per esempio `fleetcare`)
  o in quelli di sistema (`pg_catalog`, `information_schema`);
- nessun permesso di default che gli dia le tabelle future;
- nessun CREATE negli schemi o nel database.

«In regola» vuol dire: niente oltre al contratto e a quello che ogni ruolo
può fare per default in Postgres (tabelle temporanee, large object propri,
lucchetti consultivi). I large object che `argos_ro` creasse, il controllo
successivo li segnala come «proprietario di …»; gli oggetti temporanei no,
perché spariscono alla fine della sua sessione.

Tocca solo quello che è fuori posto, e ogni correzione finisce nel log
(`[migrazioni] permessi di argos_ro riportati al contratto`). Se `argos_ro` non
esiste, non fa niente.

Alcune cose non le corregge da solo, perché toccherebbero altri ruoli o
servono i loro diritti:
- permessi dati a tutti i ruoli (PUBLIC), anche fuori dagli schemi di Cerbero
  e senza USAGE sullo schema: una vista data a tutti in un altro schema può
  mostrare le tabelle di Cerbero, e `pg_stats` mostra i valori di qualunque
  colonna leggibile;
- funzioni SECURITY DEFINER che `argos_ro` può far girare: girano coi diritti
  del proprietario, quindi gli danno quello che fanno. Con l'EXECUTE contano
  se `argos_ro` ha l'USAGE sul loro schema, o se un oggetto qualunque le usa:
  operatori, viste, indici e policy le raggiungono senza nominarle, e il
  planner le valuta prima di controllare i permessi sulla tabella. Senza
  EXECUTE basta un aggregato che le usa, un event trigger che scatta con il DDL
  di chiunque, un oggetto che le chiama senza controllarlo (operatori, cast,
  classi di operatori, tipi e range, conversioni, ricerca testuale,
  TABLESAMPLE), o un cast che `argos_ro` si crea da sé su un tipo temporaneo
  (per le funzioni con primo argomento `record`). Le funzioni di FleetCare con
  l'EXECUTE di tutti, nello schema `fleetcare` dove `argos_ro` non entra, non
  contano finché nessun oggetto le usa; resta buona regola crearle con
  `REVOKE EXECUTE … FROM PUBLIC`;
- server esterni (postgres_fdw, dblink) che può usare, e sue user mapping;
- oggetti di sistema riservati, come `pg_authid` o `pg_read_binary_file`, che
  `argos_ro` può usare grazie a un altro ruolo;
- l'appartenenza di `argos_ro` a un altro ruolo (per esempio
  `pg_read_all_data`);
- `argos_ro` proprietario di qualcosa, o con attributi come SUPERUSER e
  CREATEDB;
- permessi dati da un ruolo diverso dal proprietario, o passati da `argos_ro`
  ad altri.

Questi li scrive nel log come `ATTENZIONE: argos_ro: …`, con l'istruzione da
eseguire, e intanto sistema tutto il resto. L'API parte comunque.

Il database ricorda la versione del contratto applicata
(`cerbero_migrazioni.contratti`) e **vince la più alta**. Tornare a un'immagine
precedente di Cerbero (rollback) non toglie quindi ad Argos le tabelle date da
quella più nuova: nel log, come avviso, si legge `uso il contratto vN salvato
nel database`.

Chi può scrivere quella tabella decide i permessi di Argos, quindi il contratto
salvato si usa solo se ci scrive soltanto il suo proprietario e non ha trigger
estranei. Ogni riga dice chi l'ha scritta (`scritto_da`), e un vincolo CHECK
impone che sia l'utente collegato: non si falsifica né spegnendo il trigger né
con un altro trigger. Si usa solo una riga scritta da un superutente o da chi
migra. Altrimenti vale il contratto del codice e nel log c'è un errore: si
sistema la tabella e, se serve, la si riscrive con `--forza`. L'unico trigger
ammesso è `contratti_chi_scrive` con la sua funzione. Il vincolo è `NOT VALID`:
vale per ogni scrittura, e un ripristino con pg_restore fatto da un altro
utente non si ferma sulle righe già scritte. Una versione nuova del contratto si
registra prima di applicarla: se la tabella è occupata, il migratore toglie
comunque i permessi in più ma non dà le tabelle che il contratto salvato non
ha; la versione si registra e si applica all'avvio successivo (nel log c'è un
avviso). Con `--forza` invece non rimanda: riprova, e se la tabella resta
occupata non cambia niente ed esce con un errore.

- **Per controllare** che Argos si colleghi davvero come `argos_ro` e non come
  `postgres`, dal Terminal del PostgreSQL mentre Argos lavora:
  ```sql
  SELECT usename, application_name, client_addr FROM pg_stat_activity WHERE datname = current_database();
  ```
- **Non rilanciare `argos/cerbero_readonly_user.sql`** di Argos: ridà la lettura
  di tutte le tabelle, utenti e anagrafica compresi, e di quelle future, e
  così resta fino al prossimo avvio dell'API. L'API lo nota all'avvio e ogni 6
  ore e lo scrive nel log («argos_ro non è in regola col contratto»), ma non lo
  corregge. Se è successo, rimedia subito dal **Terminal del container
  dell'API** in Coolify:
  ```bash
  node lib/db/scripts/argos-permessi.mjs --verifica   # dice cosa non va, non tocca niente
  node lib/db/scripts/argos-permessi.mjs              # riporta i permessi al contratto
  ```
  Usa `DATABASE_MIGRATOR_URL` (o `DATABASE_URL`), cioè il proprietario delle
  tabelle. Esce con 1 se resta qualcosa da sistemare a mano, e scrive
  l'istruzione da eseguire.
- **Creare `argos_ro` o cambiargli la password**, al posto dello script di
  Argos. Dal Terminal del PostgreSQL (`psql -U postgres -d postgres`):
  ```
  CREATE ROLE argos_ro LOGIN;   -- solo la prima volta
  \password argos_ro
  ```
  `\password` cifra la password in psql, così non finisce nel log del server.
  Poi, dal container dell'API, `node lib/db/scripts/argos-permessi.mjs`: dà
  USAGE sugli schemi e la lettura delle tabelle del contratto. La password va
  in `CERBERO_DATABASE_URL` di Argos.
- **Una tabella in più per Argos**:
  1. si aggiunge a `lib/db/contratti/argos-lettura.mjs`, nella stessa PR della
     modifica di Argos che la usa (o prima);
  2. si alza `ARGOS_VERSIONE`;
  3. si aggiunge la riga in `argos-lettura.versioni.json`: il test dice quale.

  Al deploy il migratore dà il permesso da solo. I test controllano che la
  tabella esista, che non sia una delle tabelle note di dati personali (utenti,
  accessi, anagrafica, roster, validazioni dei passeggeri, audit) e che non
  abbia colonne dal nome personale. Il resto lo garantisce la revisione della
  PR.
- **Togliere una tabella ad Argos**: si toglie dall'elenco e si alza la
  versione, come per aggiungerla. **Non con un revert**: il revert riporta la
  versione indietro, e il database tiene quella più alta (nel log un avviso a
  ogni avvio).
- **Se un contratto più nuovo era sbagliato**, o se il log dice che il
  contratto salvato non è affidabile, dall'immagine giusta:
  `node lib/db/scripts/argos-permessi.mjs --forza`, che applica e registra il
  contratto di quell'immagine. Poi, se serve, si rilascia una versione nuova
  del contratto.
- **Emergenza** (Argos si ferma per un permesso mancante e serve subito):
  `GRANT SELECT ON <tabella> TO argos_ro;` dal Terminal del PostgreSQL. È una
  toppa che dura fino al prossimo avvio dell'API, che la toglie: la correzione
  vera è aggiungere la tabella al contratto.

### Estensioni PostGIS che nessuno usa (tiger, topology)

A ogni avvio dell'API il controllo dei permessi di `argos_ro` scrive 11 avvisi
su due estensioni che nessuno usa, `postgis_tiger_geocoder` e
`postgis_topology`:

```
[migrazioni] ATTENZIONE: argos_ro: tiger.geocode_settings: argos_ro legge (oggetto di un'estensione)
… lo stesso per tiger.geocode_settings_default, loader_lookuptables, loader_platform,
  loader_variables, pagc_gaz, pagc_lex, pagc_rules
[migrazioni] ATTENZIONE: argos_ro: topology.layer: argos_ro legge (oggetto di un'estensione)
[migrazioni] ATTENZIONE: argos_ro: topology.topology: argos_ro legge (oggetto di un'estensione)
[migrazioni] ATTENZIONE: argos_ro: topology.topology_id_seq: argos_ro usa la sequenza (oggetto di un'estensione)
```

Sono innocui. Le estensioni, quando si installano, aprono le loro tabelle a
tutti i ruoli (PUBLIC), e dentro non c'è niente di Cerbero: le regole e il
lessico di tiger per gli indirizzi, le impostazioni del geocoder e del suo
caricatore, l'elenco delle topologie, che è vuoto. Il controllo le segnala e
non revoca niente, perché sono oggetti di un'estensione e la revoca
toccherebbe tutti i ruoli.

**Da dove arrivano.** Nessuna repo le crea. Le ha installate l'immagine
`postgis/postgis` quando Coolify ha creato il database: il suo script d'avvio
(`/docker-entrypoint-initdb.d/10_postgis.sh`) crea `postgis`,
`postgis_topology`, `fuzzystrmatch` e `postgis_tiger_geocoder` nel database
`postgres` e in `template_postgis`. Se il database si ricrea da
quell'immagine, tornano (tiger solo fino a PostGIS 3.6: dalla 3.7 lo script
non la installa più). `template_postgis` non dà avvisi e si lascia com'è.

**Prima**, dal Terminal del PostgreSQL (`psql -U postgres -d postgres`):
1. Query 1, cosa usa le due estensioni. Nessuna riga = niente.
   ```sql
   WITH membri AS (
     SELECT e.extname, m.classid, m.objid
       FROM pg_extension e
       JOIN pg_depend m ON m.refclassid = 'pg_extension'::regclass AND m.refobjid = e.oid AND m.deptype = 'e'
      WHERE e.extname IN ('postgis_tiger_geocoder', 'postgis_topology')
   ), usi AS (
     SELECT DISTINCT mb.extname, d.classid, d.objid, d.objsubid,
            CASE WHEN d.classid = 'pg_constraint'::regclass
                  AND (SELECT conrelid FROM pg_constraint WHERE oid = d.objid) = 0
                 THEN 'pg_type'::regclass ELSE 'pg_class'::regclass END AS padre_classe,
            CASE d.classid
              WHEN 'pg_rewrite'::regclass    THEN (SELECT ev_class FROM pg_rewrite    WHERE oid = d.objid)
              WHEN 'pg_attrdef'::regclass    THEN (SELECT adrelid  FROM pg_attrdef    WHERE oid = d.objid)
              WHEN 'pg_trigger'::regclass    THEN (SELECT tgrelid  FROM pg_trigger    WHERE oid = d.objid)
              WHEN 'pg_constraint'::regclass THEN (SELECT CASE WHEN conrelid = 0 THEN contypid ELSE conrelid END
                                                     FROM pg_constraint WHERE oid = d.objid)
              WHEN 'pg_class'::regclass      THEN coalesce((SELECT indrelid FROM pg_index WHERE indexrelid = d.objid), d.objid)
            END AS padre
       FROM membri mb
       JOIN pg_depend d ON d.refclassid = mb.classid AND d.refobjid = mb.objid AND d.deptype IN ('n', 'a')
   )
   SELECT u.extname AS estensione, pg_describe_object(u.classid, u.objid, u.objsubid) AS usata_da
     FROM usi u
    WHERE NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.deptype = 'e'
                        AND ((x.classid = u.classid AND x.objid = u.objid)
                          OR (x.classid = u.padre_classe AND x.objid = u.padre)))
    ORDER BY 1, 2;
   ```
2. Query 2, dati caricati e funzioni che le chiamano. `0 | 0 | 0` = niente.
   ```sql
   SELECT (SELECT count(*) FROM topology.topology) AS topologie_create,
          (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'tiger_data') AS tabelle_tiger_caricate,
          (SELECT count(*) FROM pg_proc p
            WHERE p.prosrc ~* '\m(tiger|topology)\.'
              AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.classid = 'pg_proc'::regclass
                                AND x.objid = p.oid AND x.deptype = 'e')) AS funzioni_che_le_citano;
   ```
3. Un backup del database da Coolify.
4. La ricerca nel codice. L'ultima, il 2 novembre 2026, non ha trovato usi in
   nessuna delle repo: TransitIntel `9cfc7cc`, fleetmanagement `b85999c` e
   `82e726f`, argos `b273835`, avm (Caronte) `afc177a` e `526b925`, validator
   `76eb5db`, rotazioni `238313f`, prenotazionijesi `c740102` e `5a76f2a`,
   controllerie `4006e33`. Se da allora è cambiato dell'SQL, si rifà in ogni
   repo:
   ```bash
   git grep -n -I -i -P 'postgis_tiger_geocoder|postgis_topology|tiger_data|\btiger\.|\btopology\.|geocode\(|reverse_geocode|geocode_intersection|normalize_address|CreateTopology|DropTopology|toTopoGeom|AddTopoGeometryColumn|TopoGeo_|ST_GetFaceGeometry|GetTopologyID|ValidateTopology|TopoGeometry|topoelement' -- . ':(exclude,glob)**/node_modules/**' ':(exclude,glob)**/dist/**' ':!DEPLOY.md'
   ```
   Nessuna riga = niente (`DEPLOY.md` è escluso perché contiene questa
   sezione). A mano si guardano anche i `search_path`, gli elenchi di schemi
   degli ORM (`schemaFilter`), i `CREATE`/`DROP EXTENSION`, le immagini e gli
   script in `docker-entrypoint-initdb.d`.

**I comandi**, come `postgres`, nella stessa sessione:
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP EXTENSION postgis_tiger_geocoder;
DROP EXTENSION postgis_topology;
COMMIT;
```
Sono senza `CASCADE`: se qualcosa le usa, Postgres rifiuta
(`cannot drop extension … because other objects depend on it`) e non toglie
niente, nemmeno l'altra estensione: il `COMMIT` risponde `ROLLBACK`. Se scade
il lock (`canceling statement due to lock timeout`) non cambia niente lo
stesso: `ROLLBACK;` e si riprova più tardi. Se si è incollato tutto il blocco,
il `COMMIT` ha già annullato e `ROLLBACK;` risponde solo
`there is no transaction in progress`. Restano gli schemi `tiger`,
`tiger_data` e `topology`, vuoti: non sono delle estensioni, non danno avvisi
e il ritorno indietro li riusa.

**Per verificare:**
- `\dx` non mostra più `postgis_tiger_geocoder` e `postgis_topology`, e mostra
  ancora `postgis` e `fuzzystrmatch`; `SELECT postgis_full_version();`
  risponde ancora, senza più `TOPOLOGY` in fondo.
- Al prossimo avvio dell'API spariscono gli avvisi su `tiger.*` e
  `topology.*`. Si controlla anche subito, dal Terminal del container
  dell'API: `node lib/db/scripts/argos-permessi.mjs --verifica`. Restano, se
  ci sono, quelli su `public.geometry_columns`, `public.geography_columns` e
  `public.spatial_ref_sys`: sono di `postgis`, che resta.

**Per tornare indietro:**
```sql
CREATE EXTENSION postgis_topology; CREATE EXTENSION postgis_tiger_geocoder;
```
Non si perde niente: non c'è nessuna topologia, `tiger_data` è vuoto e le
tabelle di consultazione di tiger le riempie l'estensione stessa. Tornano
anche gli 11 avvisi.

### L'immagine dell'API

`Dockerfile.api` parte da Node 22 (Node 20 è fuori supporto) e fa girare l'API
come utente `node`, non root: il processo scrive solo in `/app/.cache` e in
`/tmp`. `tini` fa da processo 1. Al deploy Coolify manda il segnale di arresto
e aspetta 30 s: l'API continua a rispondere ma con «Connection: close», così
le connessioni si chiudono a fine risposta e il proxy manda le richieste
successive al container nuovo; esce appena non ha richieste in corso da 1 s,
o al più tardi dopo `CERBERO_ARRESTO_SECONDI` (25 s, massimo 28). Se il
segnale arriva durante le migrazioni, la transazione viene annullata. L'immagine ha un HEALTHCHECK suo
(`docker/salute.mjs`, che chiama `/api/healthz` senza bisogno di curl): è
quello che Coolify usa se il suo healthcheck resta spento (vedi sopra).
`/api/healthz` risponde 503 solo se lo schema del database è indietro rispetto
al codice e il container non è mai stato allineato (vedi «Lo schema rispetto
al codice»). La sonda non scrive righe nel log delle richieste.

### Il lavoratore dei calcoli

I calcoli lunghi (oggi i turni guida; dalla Fase 2.6 anche turni macchina e
VCSP) non vivono più nella memoria dell'API. Diventano una riga in
`coda.lavori`, che il **lavoratore** prende, esegue e chiude: un deploy
dell'API non li interrompe più, e la SPA ritrova il calcolo anche dopo un
riavvio.

- **Chi li esegue.** Il lavoratore è un processo a parte con la stessa
  immagine dell'API (`CERBERO_PROCESSO=lavoratore`). Finché non c'è, li
  esegue l'API stessa (esecutore interno, acceso salvo
  `CERBERO_LAVORATORE_INTERNO=0`). Due processi non prendono mai lo stesso
  lavoro: si possono tenere accesi insieme.
- **Deploy.** Al segnale d'arresto chi esegue smette di prendere lavori,
  aspetta un poco (il lavoratore 20 s, l'API 13 s) e rimette in coda quelli
  in corso, senza consumare un tentativo: li riprende il lavoratore o il
  container nuovo, da capo. Se un processo muore di colpo, il suo lavoro torna
  in coda dopo 60 s (il lease) e riparte; dopo due interruzioni è «fallito»
  con il messaggio di rilanciarlo. Un errore del calcolo o il tempo massimo
  superato non si ritentano. Se alla fine il database non risponde, la
  chiusura si ritenta per 13 s prima di lasciar fare al lease.
- **Slot.** `LAVORI_SLOT_LUNGA` e `LAVORI_SLOT_VELOCE` (default 1 e 1): quanti
  calcoli insieme per corsia. Veloce = fino a 2 minuti di budget; così un
  turno guida da 15 minuti non blocca quelli brevi. In tutto girano due
  calcoli insieme, come con il vecchio job manager, ma due lunghi (Media, Alta,
  Massima) non più: il secondo aspetta in coda. Con `LAVORI_SLOT_LUNGA=2`
  tornano a girare insieme, se la CPU basta (ogni calcolo usa fino a 8 thread
  di OR-Tools).
- **Turni guida.** Il tempo massimo del processo è 4 volte il budget, almeno
  un'ora e al massimo due: lo script sfora il budget di molto sulle reti
  grandi, e il tempo massimo serve solo contro un processo appeso. Ogni utente
  ha al massimo 3 calcoli in coda o in corso (oltre, 429). La SPA ferma sul
  server il calcolo che abbandona (rilancio, reset, uscita dalla pagina).
- **Turni macchina, VCSP e giri di Argos** (dalla PR 2.6). Anche questi
  girano nel lavoratore:
  - `POST /api/service-program/cpsat` e `/vcsp` restano sincroni per chi li
    chiama (la Fucina, la fattibilità di Argos): la rotta controlla feed e
    richiesta (i 400 e il 404 arrivano subito, senza lavoro in coda), accoda,
    legge la riga ogni secondo e risponde con lo stesso codice e lo stesso
    corpo di prima. **Se chi aspetta si scollega, il calcolo si ferma.** Al
    deploy dell'API: 15 s di grazia, poi il calcolo si ferma e la risposta è
    503 «rilancia il calcolo tra poco»;
  - corsia dal budget vero del VSP (`vspAdvanced.totalTimeOverrideSec`,
    altrimenti l'intensità: Rapida 60 s, Normale 180, Media 420, Massima 900;
    `timeLimit` non conta, il Python lo ignora): CP-SAT fino a 3 minuti nella
    corsia veloce, il resto e il VCSP nella lunga. Tempo massimo: CP-SAT 4
    volte il budget, almeno un'ora e al più due; VCSP e giri due ore;
  - al più 3 calcoli dei turni macchina vivi per utente (oltre, 429);
  - `?asincrono=1` risponde subito 202 `{jobId}`; lo stato si legge da
    `GET /api/service-program/lavori/:jobId`, lo stop è
    `POST /api/service-program/lavori/:jobId/stop` (solo chi l'ha lanciato e
    l'admin; agli altri 404). La SPA lo userà dalla 2.7;
  - **giri di Argos** (`agent-optimize`): un giro per progetto per tutti i
    processi (409 con il `jobId` del giro vivo); il giro sopravvive al deploy
    dell'API e lo stato resta «running» finché il lavoratore lo esegue (prima,
    dopo un deploy, diceva «interrotto»). Scenario turni macchina e turni
    guida si salvano in una transazione sola: tutto o niente. Lo stop è
    `POST /api/service-program/agent-optimize/:jobId/stop`;
  - le righe `PROGRESS` del solver non vanno più nel log: l'avanzamento sta
    nella riga del lavoro;
  - `LAVORI_VEICOLI_IN_CODA=0` sull'API riporta questi calcoli dentro l'API,
    come prima (serve al rilascio e per tornare indietro).
- **Python** riceve solo l'ambiente che gli serve (niente `JWT_SECRET`,
  `DATABASE_URL`, chiavi…) e lancia solo gli 8 script dell'elenco
  (`artifacts/api-server/src/lib/lavori/python.ts`).
- **Conservazione.** La riga dice chi ha lanciato quale calcolo. La leggono
  solo chi l'ha lanciato e l'admin (Argos non vede lo schema `coda`);
  risultato e richiesta si cancellano dopo 7 giorni, la riga dopo 30. Va
  riportata nel registro dei trattamenti.

**Creare il lavoratore in Coolify** (dopo il deploy dell'API con la
migrazione `0004_coda_dei_lavori`):
1. **+ New → Application**, stesso repository e branch dell'API, Dockerfile
   `Dockerfile.api`. **Nessun dominio** e nessuna porta pubblicata: il
   lavoratore non riceve richieste da fuori.
2. Variabili d'ambiente:
   - `CERBERO_PROCESSO=lavoratore`;
   - `DATABASE_URL` e, se serve, `PGSSL_NO_VERIFY` uguali a quelle dell'API;
   - `NODE_ENV=production`;
   - `LAVORI_SLOT_LUNGA=1`, `LAVORI_SLOT_VELOCE=1`;
   - `MAPBOX_TOKEN` o `MAPBOX_ACCESS_TOKEN`, se la relazione deve scaricare le
     mappe;
   - `OSRM_URL`, se l'API ce l'ha: la matrice dei fuorilinea dei turni
     macchina la calcola il lavoratore (senza, usa il router pubblico).
   Non servono `JWT_SECRET`, `CERBERO_CHIAVE_MFA`, `CRON_SECRET`, né
   `DATABASE_MIGRATOR_URL`: il lavoratore non migra (lo fa l'API) e non ha
   utenti.
3. **Health check di Coolify: spento**, come per l'API: vale l'HEALTHCHECK
   dell'immagine, che chiama `/api/healthz` del lavoratore (sulla porta
   `PORT`, 3000, solo da dentro il container). Il lavoratore risponde 200
   anche con lo schema indietro: non riceve traffico, e un 503 farebbe
   scartare a Coolify il container nuovo quando parte prima che l'API abbia
   applicato una migrazione. Se prende lavori lo dice `prendeLavori`.
4. **Limiti di CPU e memoria**: sulla macchina da 4 vCPU e 8 GB, **3 CPU e
   3,5 GB** (dalla 2.6, con turni macchina e VCSP). Il VCSP è il calcolo più
   pesante: se supera la memoria il container riparte e il lavoro torna in
   coda (al secondo abbandono è «fallito»). Lo stesso budget su meno CPU dà
   soluzioni un po' peggiori: va guardato sui giri veri.
5. **Watch Paths**: il lavoratore si ridistribuisce solo quando cambia quello
   che esegue:
   ```
   scripts/**
   requirements.txt
   Dockerfile.api
   docker/**
   lib/db/**
   artifacts/api-server/src/lavoratore.ts
   artifacts/api-server/src/lib/lavori/**
   artifacts/api-server/src/lib/ottimizza-veicoli/**
   artifacts/api-server/src/lib/dati-solver.ts
   artifacts/api-server/src/lib/deadhead-matrix.ts
   artifacts/api-server/src/lib/geo-utils.ts
   artifacts/api-server/src/lib/scripts-dir.ts
   artifacts/api-server/src/lib/guardia-schema.ts
   artifacts/api-server/src/lib/logger.ts
   artifacts/api-server/build.ts
   artifacts/api-server/package.json
   pnpm-lock.yaml
   ```
6. Deploy, poi nel log: «Lavoratore dei calcoli avviato» e «Schema del
   database allineato al codice». Se lo schema è indietro (l'API non ha
   ancora migrato) il lavoratore aspetta, senza prendere lavori, e riparte da
   solo entro 15 s dalla migrazione. Se resta indietro, guarda il deploy
   dell'API: è lei che applica le migrazioni.
7. Lancia un turno guida dalla Fucina: nel log del lavoratore compare «lavoro
   preso». Dal Terminal del PostgreSQL:
   ```sql
   SELECT stato, preso_da, creato_il, finito_il FROM coda.lavori ORDER BY creato_il DESC LIMIT 5;
   ```
   `preso_da` comincia con `lavoratore:`.
8. Quando il lavoratore è sano, sull'API `CERBERO_LAVORATORE_INTERNO=0` e
   redeploy: da lì i calcoli girano solo sul lavoratore.

**Tornare indietro:** `CERBERO_LAVORATORE_INTERNO=1` sull'API (o togliere la
variabile) e fermare il lavoratore: i lavori in coda li prende l'API.

**Passare turni macchina, VCSP e giri al lavoratore (PR 2.6)**
0. **Prima del merge**, in Coolify:
   - sull'API `LAVORI_VEICOLI_IN_CODA=0` e redeploy: l'API nuova calcolerà
     ancora dentro di sé, finché il lavoratore nuovo non è pronto;
   - sul lavoratore: le Watch Paths nuove (sopra: `ottimizza-veicoli/**`,
     `dati-solver.ts`, `deadhead-matrix.ts`, `geo-utils.ts`,
     `scripts-dir.ts`), `OSRM_URL` se l'API ce l'ha, limiti 3 CPU e 3,5 GB.
1. **Merge.** Si ridistribuiscono API e lavoratore. Nel log del lavoratore,
   alla riga «Lavoratore dei calcoli avviato», `tipi` deve contenere
   `ottimizza_veicoli@1` e `giro_agente@1`.
2. **Accensione**, quando nessun giro di Argos è in corso: si toglie
   `LAVORI_VEICOLI_IN_CODA` dall'API e la si ridistribuisce.
3. **Prova**: un CP-SAT «Rapida» dalla Fucina, la fattibilità di Argos, un
   giro di Argos. Poi dal Terminal del PostgreSQL:
   ```sql
   SELECT tipo, corsia, stato, http_codice, preso_da,
          pg_column_size(risultato) / 1024 AS kb, finito_il - iniziato_il AS durata
     FROM coda.lavori WHERE tipo IN ('ottimizza_veicoli', 'giro_agente')
    ORDER BY creato_il DESC LIMIT 10;
   ```
   `preso_da` comincia con `lavoratore:`; la corsia è `veloce` per la Rapida
   e la fattibilità, `lunga` per il VCSP e i giri.

**Tornare indietro (2.6):** `LAVORI_VEICOLI_IN_CODA=0` sull'API e redeploy.
Per un revert del codice, prima si fermano i lavori nuovi ancora vivi:
```sql
UPDATE coda.lavori SET
       stato = CASE WHEN stato = 'in_coda' THEN 'fermato' ELSE stato END,
       errore_tipo = CASE WHEN stato = 'in_coda' THEN 'annullato' ELSE errore_tipo END,
       finito_il = CASE WHEN stato = 'in_coda' THEN now() ELSE finito_il END,
       annulla = true, aggiornato_il = now()
 WHERE tipo IN ('ottimizza_veicoli', 'giro_agente') AND stato IN ('in_coda', 'in_corso');
```
Il lavoratore di prima non conosce quei tipi e li lascerebbe in coda.

---

## STEP 2: Backend API — `Dockerfile.api`

1. **+ New → Application → da repository Git** (collega questo repo).
2. Build: **Dockerfile**, percorso `Dockerfile.api`. Branch: `main`.
3. Porta esposta: **3000**.
4. Imposta le **variabili d'ambiente** (vedi tabella in fondo). Minime:
   - `DATABASE_URL` (verso il servizio DB di Coolify)
   - `PGSSL_NO_VERIFY=1` se il Postgres usa un certificato self-signed
   - `NODE_ENV=production`, `PORT=3000`
   - `JWT_SECRET` (genera con `openssl rand -hex 32`) — **OBBLIGATORIO**: senza,
     in produzione l'API rifiuta l'avvio (i token sarebbero forgiabili)
   - `CERBERO_API_KEY` — **OBBLIGATORIA** se usi Caronte (validatore/AVM): senza,
     gli endpoint `/api/caronte/*` rispondono 503 fail-closed
   - `CRON_SECRET` (genera con `openssl rand -hex 32`): i job dei dati, da
     dare allo scheduler esterno
   - `ARGOS_CRON_SECRET` (genera con `openssl rand -hex 32`, **diverso** da
     `CRON_SECRET`) se usi Argos: è solo del backend di Argos. Senza, il
     connettore MCP di Argos e il rinnovo dei suoi token restano chiusi (vedi
     «Cron Jobs»)
   - `CERBERO_CHIAVE_MFA` (genera con `openssl rand -hex 32`) — **OBBLIGATORIA**:
     cifra i segreti della verifica in due passaggi; senza, in produzione l'API
     non parte. Impostala **prima** del deploy e non perderla: con un'altra chiave
     i segreti salvati non si leggono più (il log lo dice all'avvio). Per
     cambiarla vedi «Accesso sicuro» qui sotto
   - `CERBERO_ADMIN_EMAIL` e `CERBERO_ADMIN_PASSWORD` **solo se non c'è un
     amministratore attivo** (database nuovo, o recupero): l'API crea o rimette in
     piedi un amministratore con questi dati (password di almeno 12 caratteri, non
     banale). Nessun utente è scritto nel codice: senza le due variabili non si
     crea nessuno. Dopo il primo accesso cambia la password e togli
     `CERBERO_ADMIN_PASSWORD`
   - **Password pubblicate dal vecchio codice.** Fino a ottobre 2026 il bootstrap
     creava quattro utenti con password scritte nel sorgente (repo pubblico).
     All'avvio l'API disattiva ogni account che le usa ancora, e lo scrive nel log;
     chi prova a entrare con una di quelle viene disattivato. L'admin li riattiva da
     Gestione Utenti dando una password nuova. Se l'unico admin era uno di quelli,
     imposta le due variabili qui sopra e riavvia
   - `FRONTEND_URL` = dominio pubblico del Web (per il CORS, allowlist ESATTA di
     origin) — lo completi allo STEP 4
   - chiavi opzionali: `TOMTOM_API_KEY`, `MAPBOX_TOKEN`, `GOOGLE_PLACES_API_KEY`, `OPENROUTE_API_KEY`
5. Deploy. Il build compila le librerie, builda l'API e installa OR-Tools
   (Python) — può richiedere qualche minuto.
6. Assegna un **dominio** all'API (Coolify fornisce HTTPS via Traefik/Let's Encrypt),
   es. `https://api.transitintel.tuodominio.it`. Verifica `GET /api/healthz`:
   deve rispondere 200 con `"schema":"ok"`.

> L'API ha bisogno di **Python + OR-Tools** per gli scheduler: ci pensa
> `Dockerfile.api` (installa `python3` e OR-Tools da `requirements.txt`). Non
> serve configurare nulla a mano.

---

## STEP 3: Frontend Web — `Dockerfile.web`

1. **+ New → Application → da repository Git** (stesso repo).
2. Build: **Dockerfile**, percorso `Dockerfile.web`. Branch: `main`.
3. Porta esposta: **80**. Assegna un **dominio** (HTTPS), es. `https://transitintel.tuodominio.it`.

> ⚠️ **Importante — variabili `VITE_*` sono build-time.**
> Vite "cuoce" le variabili `VITE_...` **durante il build** (stage builder del
> `Dockerfile.web`), non a runtime. Vanno quindi fornite come **build args / env
> di build** in Coolify, altrimenti finiscono vuote nel bundle. Le principali:
> - `VITE_MAPBOX_TOKEN` — token Mapbox per le mappe.
> - `VITE_API_BASE_URL` — URL pubblico dell'API (es. `https://api.transitintel.tuodominio.it`).

> ℹ️ **Come il Web raggiunge l'API.** `nginx.conf` serve solo la SPA e **non** fa
> proxy di `/api`. Hai due strade valide:
> 1. **Cross-origin (consigliata qui):** imposta `VITE_API_BASE_URL` (build-time)
>    al dominio dell'API. Il frontend chiama direttamente l'API su un altro dominio;
>    il cookie di sessione `ti_auth` è `SameSite=None; Secure`, quindi **entrambi i
>    domini devono essere in HTTPS** (Coolify lo fa) e l'API deve avere
>    `FRONTEND_URL` corretto per il CORS.
> 2. **Same-origin via proxy:** instradi `/api` verso il servizio API (reverse
>    proxy / regola di dominio Coolify) e lasci `VITE_API_BASE_URL` vuoto. In
>    questo caso il cookie può restare `SameSite=Lax`.

---

## STEP 4: Collegamento Web ↔ API (CORS + cookie)

1. Sull'**API** imposta `FRONTEND_URL` = dominio pubblico del **Web**
   (es. `https://transitintel.tuodominio.it`). Abilita il CORS e l'invio del cookie.
2. Sul **Web**, assicurati che `VITE_API_BASE_URL` (build-time) punti all'API e
   **ri-builda** (le `VITE_*` cambiano solo con un nuovo build).
3. Entrambi su **HTTPS** (necessario per il cookie cross-site `SameSite=None; Secure`).

---

## STEP 5: Popola i Dati

Dall'app, menu **Amministrazione → Dati e integrazioni** (permesso Analisi, o admin):
1. **Popolazione — ISTAT** → comuni della provincia di Ancona
2. **Punti di Interesse** → Google Places o OpenStreetMap
3. **Traffico — TomTom** → primo snapshot
4. **Import GTFS** → carica il feed (Conerobus)

Oppure da terminale (sostituisci il dominio API e il secret):
```bash
curl -X POST https://api.transitintel.tuodominio.it/api/cron/population \
  -H "x-cron-secret: IL-TUO-CRON-SECRET"

curl -X POST https://api.transitintel.tuodominio.it/api/cron/poi \
  -H "x-cron-secret: IL-TUO-CRON-SECRET"

curl -X POST https://api.transitintel.tuodominio.it/api/cron/traffic \
  -H "x-cron-secret: IL-TUO-CRON-SECRET"
```

### Anagrafica del personale

Il roster ha un'anagrafica completa dei conducenti (menu Personale →
Anagrafica). Le tabelle sono nello schema delle migrazioni (`0000_baseline`).

1. **Subito dopo il rilascio**, dalla Gestione Utenti accendi il permesso
   **«Personale»** a chi tiene l'anagrafica (ufficio personale, chi fa il
   roster). Prima del rilascio non si può: la Gestione Utenti non conosce
   ancora il permesso. Nessun utente esistente lo riceve da sé, e finché non lo
   ha, chi ha solo lo Scheduling vede i dati operativi (niente contatti tranne
   il cellulare, paghe, ferie, date delle visite), non modifica le schede delle
   persone vere e non importa; crea e modifica solo conducenti fittizi. Gli
   admin vedono e modificano tutto.
2. Carica i dipendenti da **Importa da Excel** (.xlsx o .csv): va bene
   l'esportazione della tabella dei dipendenti del gestionale. La prova mostra
   riga per riga che cosa succederebbe; l'applicazione è tutto o niente.
3. Al primo avvio l'API controlla le matricole: se due conducenti attivi hanno
   la stessa, la pagina lo segnala e l'indice unico non si crea. Il controllo
   si ripete ogni mattina: sistemati i doppioni, l'indice arriva da sé (o al
   primo riavvio).
4. Al primo avvio, una volta sola, l'API sistema i dati del roster di prima:
   le scadenze di patente e CQC scritte a mano nella scheda vecchia passano
   nello storico, gli esiti delle visite scritti a mano diventano quelli
   dell'elenco, il numero della patente si prende dal CQC dove manca.

### Roster: riposi fra i turni

Fra due turni dello stesso conducente servono almeno **8h se urbani, 9h se
uno è extraurbano**, e due turni non si sovrappongono. Assegnando o
scambiando un turno che non lo rispetta il roster avvisa; si può procedere lo
stesso e il turno resta segnato come forzato (chi, quando). Le colonne si
sono nello schema delle migrazioni.

1. **Dopo il rilascio**, in Planning Studio → Unità di Progettazione, controlla
   per ogni unità il campo **Servizio**. Finché nessuno lo sceglie vale la
   proposta dalle linee (urbane le reti di Ancona, Jesi, Falconara, Senigallia
   e Castelfidardo; extraurbana l'unità se ha anche una sola corsa
   extraurbana). Le unità miste vanno decise a mano.
2. I turni guida senza un'unità vanno col «Tipo di servizio» scelto in Fucina
   al calcolo; se manca anche quello, il roster presume 9h e lo dice
   nell'avviso.
3. Le assegnazioni già fatte prima del rilascio non bloccano niente: il
   tabellone mostra in rosso quelle che violano le regole, da controllare.

### Accesso sicuro

**Prima del rilascio.** Al rilascio del permesso Roster, chi aveva Scheduling
lo riceve in automatico; con l'accesso sicuro, Roster rende obbligatoria la
verifica in due passaggi. Quindi:
1. imposta `CERBERO_CHIAVE_MFA`;
2. se il permesso Roster è già in esercizio (rilascio precedente), togli
   Roster in Gestione Utenti a chi non lavora sul roster;
3. avvisa admin e utenti di Personale e Roster (e, se Roster arriva con
   questo stesso rilascio, tutti quelli con Scheduling) che serve un'app di
   autenticazione sul telefono.

Dopo il rilascio tutti devono rientrare (le sessioni di prima non valgono più).
L'admin entra per primo e attiva la sua verifica; se Roster è arrivato con
questo rilascio, toglie subito Roster a chi non lavora sul roster, **prima**
di dire agli altri di entrare: chi non ha più Roster (né Personale) non deve
attivare la verifica.

- **Verifica in due passaggi** (codice a 6 cifre da un'app come Google o
  Microsoft Authenticator) obbligatoria per admin e per chi ha i permessi
  Personale o Roster; facoltativa per gli altri. Chi deve attivarla, al primo
  accesso vede solo la pagina «Sicurezza dell'account» finché non l'ha fatto.
  Le sorveglianze e il connettore di Argos non partono per chi deve ancora
  attivarla (o cambiare la password provvisoria): lo dicono nel loro esito.
- **Password**: almeno 12 caratteri; quella data dall'admin è provvisoria e va
  cambiata al primo accesso.
- **Tentativi sbagliati**:
  - password, dallo stesso indirizzo: dopo 5 errori quell'indirizzo aspetta 15
    minuti, poi il doppio a ogni errore, al massimo un giorno. Chi sbaglia da un
    altro posto non blocca il titolare;
  - password, da qualunque indirizzo: al massimo 20 errori in 15 minuti, poi
    l'account aspetta 15 minuti (ferma chi prova da tanti indirizzi). Questo
    blocco non vale dai browser da cui la persona è già entrata (un cookie
    firmato, 180 giorni; cambio password, «esci da tutti i dispositivi»,
    password provvisoria e disattivazione lo annullano sugli altri browser,
    mentre attivare o rifare la verifica, «Reimposta verifica» e il
    ripristino dell'admin no): lì gli errori fanno una serie a parte, 5 e poi
    l'attesa. Se qualcuno tiene bloccata la
    password dell'unico admin, l'admin entra dal suo solito computer; se il
    blocco è sui codici della verifica, qualcuno conosce la sua password:
    cambiala (da un'altra sessione aperta, o con `CERBERO_ADMIN_RIPRISTINA`);
  - codici della verifica: dopo 5 errori 15 minuti, poi il doppio, al massimo
    un giorno (chi li sbaglia conosce già la password: se non è il titolare,
    la password va cambiata).
  Gli stessi limiti valgono per la password e i codici chiesti dentro la pagina
  «Sicurezza dell'account». L'admin sblocca da Gestione Utenti; anche dare una
  password provvisoria sblocca la password.
- **Sessioni**: durano 12 ore dall'accesso, sempre; cambio password,
  reset della verifica e «esci da tutti i dispositivi» chiudono le altre
  sessioni senza allungare quella in uso.
- **Registro degli accessi** in Gestione Utenti, conservato 12 mesi.
- **Telefono perso**: l'utente entra con un codice di recupero e, nella pagina
  «Sicurezza dell'account», ridando la password rifà la verifica con il
  telefono nuovo. Oppure l'admin usa «Reimposta verifica». Se è l'unico admin
  ad averlo perso: imposta `CERBERO_ADMIN_EMAIL`, `CERBERO_ADMIN_PASSWORD` e
  `CERBERO_ADMIN_RIPRISTINA=1`, riavvia, entra, poi togli le tre variabili.
- **«Credenziali non valide» con la password giusta.** Il login dà lo stesso
  messaggio per tre motivi diversi, per non rivelare quali account esistono.
  Il registro degli accessi li distingue (`accessi_log.esito`):
  - `utente_inattivo`: la password è giusta ma l'account è disattivato. Succede
    per esempio a un account che usava una password pubblicata, dopo che gli
    si è data solo una password nuova. Va anche riattivato: il dialogo «Reset
    password» lo propone per gli account disattivati;
  - `password_errata`: la password salvata non è quella che si scrive. Una
    riga `admin:password_provvisoria (…)` dice chi l'ha cambiata e quando;
  - `utente_sconosciuto`: l'email è scritta diversa.

  Se non entra più nessun admin, si legge direttamente dal database:
  ```sql
  SELECT ts, email, esito, ip FROM accessi_log ORDER BY ts DESC LIMIT 30;
  SELECT email, role, active, deve_cambiare_password, mfa_attiva, password_cambiata_il, last_login_at
    FROM users ORDER BY role, lower(trim(email));
  ```
  In tutti e tre i casi rientri con il ripristino:
  1. imposta `CERBERO_ADMIN_EMAIL` (l'email esatta della query),
     `CERBERO_ADMIN_PASSWORD` e `CERBERO_ADMIN_RIPRISTINA=1`. La password va
     scelta con le regole qui sopra e senza `$`, che Coolify può interpretare
     come variabile;
  2. riavvia. Il log dice «amministratore … rimesso in piedi da
     CERBERO_ADMIN_*». Se dice «creato (nessun utente aveva questa email)»,
     l'email non era quella dell'admin;
  3. entra e cambia subito la password;
  4. togli le tre variabili e riavvia di nuovo. Con `CERBERO_ADMIN_RIPRISTINA=1`
     ancora impostata, a ogni riavvio la password torna quella della
     variabile. Senza `CERBERO_ADMIN_RIPRISTINA`, se c'è un admin attivo, le
     altre due non fanno niente: il log lo dice.
- **Cambiare `CERBERO_CHIAVE_MFA`** (per esempio se è uscita):
  1. metti la nuova in `CERBERO_CHIAVE_MFA` e la vecchia in
     `CERBERO_CHIAVE_MFA_PRECEDENTE`, riavvia: all'avvio tutti i segreti della
     verifica si ricifrano con la nuova;
  2. i codici di recupero non si possono ricifrare (se ne tiene solo
     l'impronta): finché la vecchia resta impostata valgono, e chi li ha
     ancora vecchi lo vede all'ingresso e in «Sicurezza dell'account»;
     Gestione Utenti segna «codici di recupero da rifare», e il log all'avvio
     dice chi sono;
  3. quando nessuno è più segnato, o dopo aver usato «Reimposta verifica» per
     chi resta, togli `CERBERO_CHIAVE_MFA_PRECEDENTE` e riavvia. Se lo togli
     prima, i codici di recupero rimasti non valgono più (il codice dell'app
     sì): rispondono «non disponibile» senza contare errori, e si rifanno da
     «Sicurezza dell'account».
  Se una chiave manca del tutto, la verifica risponde «non disponibile» e il
  log all'avvio dice chi è coinvolto.
- **Indirizzo dei client**: il blocco per indirizzo e i limiti per IP usano
  l'indirizzo che arriva dal proxy davanti all'API. Con Coolify (un solo
  proxy, Traefik) va bene così; se metti davanti un altro proxy (una CDN, o
  nginx che inoltra `/api`) imposta `CERBERO_TRUST_PROXY` al numero dei proxy,
  e non pubblicare mai la porta dell'API direttamente. Con una CDN anche
  Traefik deve fidarsi degli indirizzi della CDN (`forwardedHeaders.trustedIPs`),
  altrimenti tutti risultano con l'indirizzo della CDN. Per controllare: nel
  registro degli accessi (Gestione Utenti) l'IP deve essere quello vero di
  chi entra. Se in produzione l'indirizzo risulta interno, il log lo segnala.
- **FleetCare** (dalla sua migrazione 0088): chi ha un account Cerbero ci entra
  **solo** da Cerbero, dal pulsante FleetCare nel menu o da `<cerbero>/fleetcare`
  (è l'indirizzo del pulsante «Entra con Cerbero» sulla pagina di login di
  FleetCare). Il modulo di FleetCare resta solo per gli account locali (officine
  esterne), con il blocco dei tentativi. FleetCare ricontrolla la sessione ogni
  ~30 secondi: disattivazione, permesso o ruolo FleetCare cambiati, «esci da
  tutti i dispositivi», cambio password e verifica da attivare la chiudono.
  Uscire da Cerbero non chiude FleetCare, che comunque scade 12 ore dopo
  l'accesso a Cerbero. **Ordine di rilascio: prima Cerbero, poi FleetCare.**
  Per tornare indietro l'ordine è il contrario: prima FleetCare, poi Cerbero.
  Mai Cerbero da solo a una versione precedente mentre FleetCare ha la 0088: i
  suoi biglietti non entrano e chi ha un account Cerbero resta fuori da
  FleetCare. Nel registro degli accessi la voce «biglietto per FleetCare
  emesso» dice che Cerbero ha dato il biglietto, non che FleetCare l'ha accettato.
- Riferimenti da verificare con il DPO: GDPR art. 32; Direttiva NIS2
  2022/2555 art. 21 (autenticazione a più fattori «dove appropriato»); se
  Conerobus rientri nel D.Lgs. 138/2024.

### Roster: pubblicazione dei turni guida

Il roster riceve i turni guida da un solo canale, **Turni al roster** (menu
Pubblicazione, o «Pubblica nel Roster» dal Quadro d'esercizio): si
sceglie programma e periodo, e per ogni Unità di Progettazione quale turni
guida vale nei suoi giorni (proposto quello in esercizio). Le tabelle si
sono nello schema delle migrazioni.

1. **Dopo il rilascio il tabellone non ha turni**: ogni giorno è «non
   pubblicato» e non si assegna finché non si pubblica. Le assegnazioni di
   prima restano visibili. Fai subito la prima pubblicazione per il periodo in
   corso: l'anteprima dice quante assegnazioni restano, quante passano a un
   turno uguale di un altro turni guida e quante restano da riassegnare.
2. I giorni di ogni unità sono le sue date (Unità di Progettazione) al momento
   della pubblicazione: se il calendario cambia, ripubblica il periodo.
3. Un turni guida pubblicato o con assegnazioni **non si cancella e non si
   sovrascrive**: salvandolo se ne crea una nuova versione. Per la stessa
   ragione non si cancella un turni macchina, un programma di esercizio o un
   progetto di scheduling i cui turni guida sono pubblicati o assegnati.
4. Pubblica chi ha il permesso Scheduling e vede il progetto di Planning
   Studio. Ogni pubblicazione e ogni ritiro restano nel registro della pagina.

### Menu e permessi

Il menu segue la giornata dell'azienda (`artifacts/transitintel/src/lib/navigazione.ts`):

| Sezione | Voci | Permesso |
|---|---|---|
| Oggi | la pagina d'ingresso | tutti |
| Rete e orari | Planning Studio, Confronta programmi, Zone di coincidenza | Rete e orari (`network`) |
| Turni | Progetti di esercizio, Turni misti, Database di esercizio | Turni (`scheduling`) |
| Pubblicazione | Turni al roster; Orari al pubblico (stampa orari, QR) | Turni; Rete e orari |
| Personale | Roster, Anagrafica | Roster; Roster o Personale |
| Esercizio | Mappa live, AVM, Tempi osservati | Esercizio (`centrale`); i Tempi osservati anche con Analisi |
| Flotta | FleetCare | Flotta (`fleetcare`) |
| Tariffe | Bigliettazione, Polimetriche, Simulatore, Prodotti e KPI, Percorso e tariffa, Documentazione ATMA | Tariffe (`fares`) |
| Analisi | Mappa del territorio, Traffico, Territorio e domanda, Linee e fermate GTFS, Ipotesi di linea | Analisi (`analytics`) |
| Amministrazione | Utenti e accessi (admin), Parametri di esercizio (admin), Dati e integrazioni (Analisi o Esercizio), Sicurezza dell'account | — |

- **Oggi** (`/oggi`) è la pagina d'ingresso. Mostra il servizio adesso dall'AVM,
  i turni del giorno nel roster (pubblicati, scoperti, assenze), il programma in
  esercizio e l'ultima pubblicazione dei turni; ognuno vede solo i riquadri dei
  suoi permessi. Dopo l'accesso si torna alla pagina chiesta (un segnalibro, un
  link); una pagina senza permesso riporta a Oggi e dice quale permesso serve.
- **Ogni API ha il suo permesso (deny by default).** Un percorso che non ha una
  voce in `PERMISSION_BY_PREFIX` (`lib/auth.ts`) risponde 403 a chi non è
  admin, e il log lo scrive come «percorso senza permesso assegnato»: se dopo
  un rilascio qualcuno prende un 403 inatteso, è una voce da aggiungere (il
  test `inventario-rotte` lo impedisce per le rotte del codice). In più:
  - Argos (`/api/ai/argos/*`, pannello dentro Planning Studio) chiede Rete e
    orari;
  - le paline Mizar e la diagnostica SIRI (`/api/siri/*`, pagina Dati e
    integrazioni) chiedono Analisi o Esercizio;
  - il lancio a mano dell'ingestione AVM (`POST /api/siri/sync`) è solo
    dell'admin;
  - le regole salvate dell'ottimizzatore e l'analisi intermodale della Fucina
    chiedono Turni;
  - la ricerca dei colleghi nelle finestre di condivisione dei progetti
    (`/api/users/lookup`) chiede Rete e orari o Turni, e non è disponibile ai
    token di Argos;
  - le sincronizzazioni delle sorgenti (`/api/admin/sync`) rispondono «Solo
    admin».
- **Il registro degli accessi** (Gestione Utenti) ora scrive anche quello che
  l'admin cambia sugli utenti: creazione ed eliminazione, ruolo, permessi
  (solo i nomi dei moduli aggiunti e tolti), ruolo FleetCare, nome (solo che
  è cambiato, non il valore), oltre a password provvisoria, verifica tolta,
  sblocco, disattivazione e riattivazione.
- **Analisi parte spenta per i nuovi utenti.** Chi la aveva la tiene: l'admin la
  toglie da Gestione Utenti a chi non la usa. Le letture che servono anche agli
  altri moduli (feed e fermate per i turni, linee e confini per le tariffe, il
  dominio dei QR per la stampa orari, l'elenco dei programmi per i turni) non
  dipendono più da Analisi. Il default della colonna lo allinea la migrazione
  `0001_allinea` (in produzione era rimasto quello iniziale); conta solo per
  chi inserisce utenti a mano, perché l'app scrive i permessi per intero.
- **Rete e orari porta con sé i Turni**, come prima. All'avvio l'app allinea chi
  aveva Rete e orari senza Turni (salvato prima che la regola valesse anche al
  salvataggio): da lì in poi vede anche i Turni.
- **Orari al pubblico** si apre sul programma in esercizio; prima chiedeva il
  permesso Analisi, ora Rete e orari (è lì che si leggono gli orari).
- **Ipotesi di linea** (gli scenari KML) ora chiede Analisi, come le sue API.
  **Dati e integrazioni** si apre con Analisi (i feed GTFS) o con Esercizio (le
  paline Mizar); la sincronizzazione delle sorgenti resta dell'admin. Il numero di autovetture aziendali usato
  dai motori dei turni si cambia solo da admin, in **Amministrazione › Parametri
  di esercizio** (prima stava nella pagina /optimization, che non c'è più).
- I vecchi indirizzi portano ai nuovi: `/network-engine` → Planning Studio,
  `/fares-engine` e `/stops-classification` → Bigliettazione, `/fucina`,
  `/optimization` e `/optimizer-*` → Progetti di esercizio, `/planning/*` →
  Confronta programmi.
- **Tolti** (nessuna pagina li usava più): il vecchio planner sugli scenari
  GTFS, l'ottimizzatore orari e di percorso di prima, le API `/stops` e
  `/routes` del primo prototipo, gli orari sul feed GTFS (si stampano da
  Planning Studio) e Virgilio, il vecchio assistente in chat. Argos resta in
  Planning Studio. Le tabelle restano dove sono: nessuna è stata cancellata.
- **Database di esercizio** mostra i turni macchina e i turni guida che
  l'utente può aprire, come gli elenchi della Fucina. La vecchia pagina dei turni guida
  (`/driver-shifts/…`) resta raggiungibile dai link della Fucina, fuori dal menu.

---

## Variabili d'Ambiente

Riferimento completo in `.env.example`. Sintesi:

### API (`Dockerfile.api`) — runtime

| Key | Obbligatoria | Note |
|---|---|---|
| `DATABASE_URL` | ✅ | `postgres://user:pass@<servizio-db>:5432/dbname` |
| `PGSSL_NO_VERIFY` | — | `1` se Postgres usa certificato self-signed |
| `DATABASE_MIGRATOR_URL` | — | utente proprietario delle tabelle, solo per le migrazioni all'avvio; senza, vale `DATABASE_URL` |
| `CERBERO_ARRESTO_SECONDI` | — | attesa massima all'arresto per le richieste in corso (default 25, massimo 28: Coolify uccide il container dopo 30 s) |
| `CERBERO_PROCESSO` | — | `api` (default) o `lavoratore`: quale processo avvia l'immagine (vedi «Il lavoratore dei calcoli») |
| `CERBERO_LAVORATORE_INTERNO` | — | `0` spegne l'esecutore dei calcoli dentro l'API, quando c'è il lavoratore (default: acceso) |
| `LAVORI_SLOT_LUNGA` / `LAVORI_SLOT_VELOCE` | — | calcoli insieme per corsia, nel lavoratore e nell'esecutore interno (default 1 e 1) |
| `LAVORI_VEICOLI_IN_CODA` | — | `0` riporta turni macchina, VCSP e giri di Argos dentro l'API (rilascio della 2.6 e ritorno indietro); default: in coda, nel lavoratore |
| `OSRM_URL` | — | router per i km dei fuorilinea dei turni macchina (default il router pubblico); dalla 2.6 serve anche al lavoratore |
| `NODE_ENV` | ✅ | `production` |
| `PORT` | ✅ | `3000` |
| `JWT_SECRET` | ✅ | `openssl rand -hex 32` |
| `CRON_SECRET` | ✅ | `openssl rand -hex 32` (header `x-cron-secret`): i job dei dati, per lo scheduler esterno |
| `ARGOS_CRON_SECRET` | con Argos | `openssl rand -hex 32`, diverso da `CRON_SECRET`: solo il backend di Argos, che lo manda come sua `TRANSITINTEL_CRON_SECRET`. Senza, le rotte dei token di Argos sono chiuse (vedi «Cron Jobs») |
| `ARGOS_CRON_PASSAGGIO` | — | `1` solo durante il cambio di segreto: le rotte di Argos accettano anche `CRON_SECRET`. Da togliere a cambio finito |
| `CERBERO_CHIAVE_MFA` | ✅ | `openssl rand -hex 32`: cifra i segreti della verifica in due passaggi. Senza, in produzione l'API non parte; non perderla |
| `CERBERO_CHIAVE_MFA_PRECEDENTE` | — | Solo durante un cambio di chiave: la chiave di prima (vedi «Accesso sicuro») |
| `CERBERO_TRUST_PROXY` | — | Quanti proxy ci sono davanti all'API (default `1`, il Traefik di Coolify), o i loro indirizzi |
| `CERBERO_ADMIN_RIPRISTINA` | — | `1` insieme alle due qui sotto: rimette in piedi quell'admin anche se risulta attivo (password o telefono persi). Poi togli tutte e tre |
| `CERBERO_ADMIN_EMAIL` | senza admin attivi | email dell'amministratore da creare o ripristinare, solo se non ce n'è uno attivo |
| `CERBERO_ADMIN_PASSWORD` | senza admin attivi | sua password (≥ 12 caratteri, non comune); da togliere dopo il primo accesso |
| `CERBERO_DATI_PROVA` | — | `1` solo sulle installazioni di prova o demo: abilita i conducenti fittizi («+30 fittizi»). In produzione lasciala vuota |
| `FRONTEND_URL` | ✅ | dominio del Web (CORS) |
| `TOMTOM_API_KEY` | — | traffico |
| `MAPBOX_TOKEN` | — | usi server-side mappe |
| `GOOGLE_PLACES_API_KEY` | — | sync POI |
| `OPENROUTE_API_KEY` | — | isocrone pedonali |
| `PROVINCE_BBOX` | — | default `12.7,43.2,13.65,43.95` |
| `LOG_LEVEL` | — | `info` / `debug` / `warn` / `error` |
| `CERBERO_API_KEY` | — | Bearer key per `/api/caronte/*` (validatore + AVM) |
| `GTFS_RT_API_KEY` | — | key per i feed `/api/gtfs-rt/*` (vuota = feed pubblico) |
| `GTFS_FEED_ID` | — | forza il feed GTFS usato da Sala Operativa / caronte |
| `FLEETCARE_SSO_SECRET` | per FleetCare | Segreto condiviso con FleetCare (stesso valore nelle due app, almeno 32 caratteri): firma il biglietto con cui si entra in FleetCare |
| `FLEETCARE_URL` | per FleetCare | Indirizzo pubblico di FleetCare, senza `/` finale |
| `FLEETCARE_TENANT` | — | slug dell'azienda in FleetCare da cui l'AVM legge il parco dell'officina (`fleetcare.parco_per_avm()`); serve solo se FleetCare ne ha più di una, di solito è lo stesso valore di `FLEETCARE_SSO_TENANT` di FleetCare |

### Web (`Dockerfile.web`) — **build-time** (build args)

| Key | Note |
|---|---|
| `VITE_API_BASE_URL` | URL pubblico dell'API (vuoto se usi un proxy same-origin) |
| `VITE_MAPBOX_TOKEN` | token Mapbox per le mappe nel frontend |

---

## Cron Jobs (Opzionale)

Automatizza la raccolta dati con uno scheduler esterno (es. **cron-job.org**) o
con i cron interni di Coolify:

| Job | Endpoint | Schedule consigliato |
|---|---|---|
| Traffico | `POST /api/cron/traffic` | ogni 15 min |
| POI | `POST /api/cron/poi` | 1° del mese, ore 3:00 |
| Popolazione | `POST /api/cron/population` | ogni lunedì, ore 4:00 |
| Controllo settimanale AVM | `POST /api/cron/avm-controllo-settimanale` | facoltativo: ogni lunedì, ore 4:00 |
| Meteo | `POST /api/cron/weather` | facoltativo: ogni ora (serve `OPENWEATHER_API_KEY`) |

Per ogni job: metodo **POST**, header `x-cron-secret: IL-TUO-CRON-SECRET`.
Il meteo prima rispondeva 401 a uno scheduler esterno (voleva anche il login):
ora basta il segreto, come per gli altri.

**Il segreto di Argos è un altro.** Argos chiama due rotte cron di Cerbero:
- `/api/cron/argos-mcp-token`, che gli dà un token di 10 minuti a nome del
  proprietario di un progetto. Il token può fare quello che può l'utente,
  scritture comprese; se è admin, tutto;
- `/api/cron/argos-mcp-projects`, con l'elenco dei progetti.

Per questo non si aprono con `CRON_SECRET`, che sta nello scheduler, ma con
`ARGOS_CRON_SECRET`, che ha solo Argos. Senza `ARGOS_CRON_SECRET` sono chiuse
(503).

**Cambiare segreto senza fermare Argos.** Oggi Argos manda `CRON_SECRET`,
nella sua `TRANSITINTEL_CRON_SECRET`. Il passaggio richiede quattro deploy, uno
alla volta, e Argos funziona sempre:
1. genera un segreto nuovo: `openssl rand -hex 32`;
2. nell'Application dell'API di Cerbero aggiungi `ARGOS_CRON_SECRET` con quel
   valore e `ARGOS_CRON_PASSAGGIO=1`, poi ridistribuisci. L'API accetta tutti e
   due i segreti, e nel log c'è l'avviso «ARGOS_CRON_PASSAGGIO è attivo»;
3. nell'Application di Argos metti lo stesso valore nuovo in
   `TRANSITINTEL_CRON_SECRET`, poi ridistribuisci. Il codice di Argos non
   cambia; il suo README, che dice di usarci `CRON_SECRET`, è superato;
4. verifica dal Terminal del container dell'API. Nell'immagine `curl` non
   c'è: si usa Node, che legge i due segreti dall'ambiente del container (non
   vanno incollati):
   ```sh
   node -e 'const u="http://localhost:"+(process.env.PORT||3000)+"/api/cron/argos-mcp-projects";const p=s=>fetch(u,{method:"POST",headers:{"x-cron-secret":s||""}}).then(r=>r.status);(async()=>{console.log("con ARGOS_CRON_SECRET:",await p(process.env.ARGOS_CRON_SECRET));console.log("con CRON_SECRET:",await p(process.env.CRON_SECRET))})()'
   ```
   Con `ARGOS_CRON_SECRET` deve dare `200`. Con `CRON_SECRET` dà `200` finché
   il passaggio è attivo: è normale. Una prova nel pannello di Argos in
   Planning Studio non basta, perché il pannello non passa da queste rotte. Il
   connettore MCP invece sì (strumento `argos_projects`);
5. nell'API togli `ARGOS_CRON_PASSAGGIO` e ridistribuisci. Ora, con
   `CRON_SECRET`, lo stesso comando deve dare `401`.

Se Argos manda un segreto sbagliato, il log dell'API lo dice («una rotta cron
di Argos ha ricevuto un segreto sbagliato»), al massimo una volta l'ora. Lo
stesso vale per `ARGOS_URL` impostata senza `ARGOS_CRON_SECRET` e per i due
segreti uguali.

Il giro della sorveglianza di Argos (`/api/cron/argos-watch`) resta su
`CRON_SECRET`, perché lo lancia lo scheduler. Fa lavorare Argos a nome
dell'utente, ma allo scheduler non consegna token né contenuti: risponde solo
coi conteggi. Le sorveglianze si prenotano prima del giro, quindi due tick
insieme non rifanno lo stesso lavoro. I segreti si confrontano a tempo
costante.

Il controllo settimanale AVM non ha bisogno dello scheduler esterno: con il
connettore SIRI attivo, il processo dell'API controlla ogni ora se c'è una
settimana chiusa senza controllo archiviato e la calcola (il primo giro dopo
le 03:00 di lunedì). L'endpoint serve solo a chi vuole lanciarlo da fuori; è
idempotente. L'archivio è la tabella `caronte.avm_controllo_settimanale`
(nello schema delle migrazioni).

**L'andamento AVM e le richieste a Mizar** (pagina AVM, scheda «Andamento»).
L'andamento si ricalcola dal diario dell'AVM (`caronte.avm_diario`) a ogni
apertura, settimana per settimana dall'inizio dei dati (al massimo un anno),
con la stessa regola del controllo settimanale. Non c'è niente da
configurare:
- la migrazione `0005_richieste_mizar` crea `caronte.avm_richieste_mizar`
  (vuota, senza lock su tabelle esistenti). Non serve rieseguire
  `caronte_setup.sql` né toccare i permessi di Argos: la tabella è fuori dal
  contratto di `argos_ro` e `caronte_app` non la vede;
- le liste «da togliere da SIRI», «da aggiungere a SIRI» e «da verificare»
  vengono dal parco di FleetCare (`fleetcare.parco_per_avm()`). Senza
  FleetCare restano vuote e la pagina lo dice;
- una richiesta a Mizar si chiude da sola quando il diario lo dimostra:
  «togliere» dopo 3 giornate contate senza la vettura nel flusso, «aggiungere»
  il primo giorno in cui la vettura compare. Le richieste chiuse si
  cancellano dopo 24 mesi; di chi le segna si tiene solo l'id, e il nome non
  esce nel foglio Excel;
- scrive solo chi ha il permesso «centrale», come per il resto dell'AVM.

---

## Dev Locale

```bash
# Installa dipendenze
pnpm install

# Crea .env dalla template e compila i valori
cp .env.example .env

# Crea o aggiorna lo schema del database (le migrazioni di lib/db/migrations)
DATABASE_URL=… pnpm --filter @workspace/db run migra

# Avvia backend (oppure ./start-backend.sh, che migra da sé)
cd artifacts/api-server && pnpm run dev

# Avvia frontend (in un altro terminale)
cd artifacts/transitintel && PORT=5173 pnpm run dev
```

In locale, il proxy di Vite gira `/api` verso il backend, quindi `VITE_API_BASE_URL`
può restare vuoto e il cookie usa `SameSite=Lax`.

### Test (gli stessi della CI)

```bash
# API: senza database. I test non usano MAI DATABASE_URL; un database di
# prova, se serve, si passa con TEST_DATABASE_URL
pnpm --filter @workspace/api-server run test

# SPA: il menu (profili di permesso, nessuna sezione vuota) e i conti delle pagine
pnpm --filter @workspace/transitintel run test

# Solver Python
python3 -m pip install -r requirements-dev.txt
cd scripts && python3 -m pytest -q
```

La CI prova anche le migrazioni su Postgres 17 (job `migrazioni-postgres`):
i passi si ripetono in locale come spiegato in `lib/db/migrations/README.md`.

---

## Troubleshooting

| Problema | Soluzione |
|---|---|
| Mappa non carica | `VITE_MAPBOX_TOKEN` deve essere passato **a build-time** al Web e poi ri-buildare |
| Frontend non chiama l'API | Verifica `VITE_API_BASE_URL` (build-time) o il proxy `/api`; controlla la Network del browser |
| Login non persiste / 401 | Cookie cross-site: servono **HTTPS** su entrambi i domini + `FRONTEND_URL` corretto sull'API |
| CORS blocked | Imposta `FRONTEND_URL` sull'API col dominio esatto del Web |
| API 500 / DB | Controlla `DATABASE_URL`; se TLS self-signed imposta `PGSSL_NO_VERIFY=1`; testa `GET /api/healthz` |
| DB connection refused | Verifica che API e DB siano nello **stesso progetto Coolify** e usa l'hostname interno del servizio |
| Scheduler non parte | OR-Tools (Python) è installato dal `Dockerfile.api`; controlla i log del build dell'API |
