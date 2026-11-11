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
   > Dalla 2.8 si esegue come `postgres`, non come `cerbero_app`, che non crea
   > ruoli. Dal Terminal del container dell'API:
   > `DATABASE_URL="$DATABASE_MIGRATOR_URL" node lib/db/scripts/run-sql.mjs caronte_setup.sql`.
   > Il resto è in «Ruoli del database», «Caronte e gli altri programmi».

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
  `DATABASE_URL`: serve un **superutente** (`postgres`), perché le migrazioni
  cambiano tabelle di `cerbero_owner` e dopo di loro il migratore tiene in
  ordine i ruoli del database (vedi «Ruoli del database»). Come `cerbero_app`
  il migratore si ferma e l'API non parte: `DATABASE_MIGRATOR_URL` va
  impostata **prima** di passare `DATABASE_URL` a `cerbero_app`. Il container
  parte come root solo per le migrazioni: poi `docker/avvio.sh` toglie la
  variabile e avvia l'API come utente `node`, che non la può più leggere da
  nessuna parte (né dal suo ambiente né da quello del processo 1). Resta
  leggibile dal **Terminal** del container, che è root: è lì che servono gli
  strumenti a mano (`ruoli.mjs`, `argos-permessi.mjs`).
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
  Usa `DATABASE_MIGRATOR_URL` (o `DATABASE_URL`), cioè `postgres`. Esce con 1
  se resta qualcosa da sistemare a mano, e scrive l'istruzione da eseguire.
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

### Ruoli del database (PR 2.8): l'app non è più superutente

Fino alla 2.7 API, lavoratore e migratore entravano come `postgres`, il
superutente, e le tabelle erano sue: un SQL iniettato o una dipendenza
compromessa potevano leggere e cambiare tutto (FleetCare, `caronte.app_users`,
file del server, ruoli). Dalla 2.8:

| Ruolo | Cosa è | Chi lo usa |
|---|---|---|
| `cerbero_owner` | NOLOGIN: proprietario delle tabelle, viste e sequenze di Cerbero (public, caronte, coda) | nessuno direttamente |
| `cerbero_app` | l'utente dell'app: membro di `cerbero_owner` (con SET, senza ereditarne i diritti) e con `role = cerbero_owner`, quindi ogni sua sessione lavora come proprietario | API e lavoratore (`DATABASE_URL`) |
| `postgres` | superutente: migrazioni, ruoli, permessi di Argos | migratore (`DATABASE_MIGRATOR_URL`), Terminal |
| `caronte_app` | l'utente di Caronte (`caronte_setup.sql`): scrive le tabelle del validatore e dell'AVM, legge le GTFS, possiede `caronte.app_users` | Caronte (`DATABASE_URL` e `CARONTE_URL` del suo servizio) |

- **Chi li tiene in ordine.** Il migratore, a ogni avvio dell'API, dopo le
  migrazioni (`lib/db/scripts/ruoli-regole.mjs`):
  - crea i due ruoli se mancano;
  - dà a `cerbero_owner` USAGE e CREATE su `public`, `caronte` e `coda`;
  - gli dà USAGE su `cerbero_migrazioni` e la lettura della tabella di
    tracciamento e dei contratti. `cerbero_migrazioni` resta di `postgres`,
    così il contratto di Argos lo scrive solo chi migra;
  - passa a `cerbero_owner` le relazioni del catalogo
    (`lib/db/migrations/meta/catalogo.json`) che sono di un superutente: una
    per transazione, con un lock di 1 s al massimo e circa 25 s in tutto. Un
    oggetto occupato si riprova al prossimo avvio;
  - non tocca mai le estensioni (PostGIS), `caronte.app_users` né gli oggetti
    di un altro ruolo (per esempio del sistema AVM): per questi ultimi scrive
    nel log l'istruzione da eseguire.

  `ALTER … OWNER` riscrive i permessi già dati (ad `argos_ro`, `caronte_app`,
  `fleetcare_app`), che restano validi.
- **L'app non crea oggetti eseguibili.** Il migratore crea e tiene acceso
  sempre (`ENABLE ALWAYS`) l'event trigger `cerbero_ddl_dell_app`, di
  `postgres`: come `cerbero_app` si eseguono solo i comandi delle unità pigre
  (`CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`). Funzioni (anche
  temporanee), viste, operatori, aggregati, tipi, cast, regole, trigger e
  policy si fermano con «cerbero_app non può eseguire …». Senza, un oggetto
  messo dall'app in `public` (dove ha CREATE per le unità pigre) girerebbe come
  superutente quando lo incontra il migratore, un amministratore in psql o una
  funzione di FleetCare (la revisione lo ha riprodotto).
- **Né espressioni pericolose.** Un secondo event trigger,
  `cerbero_ddl_dell_app_fine` (a fine comando, stessa funzione), guarda i
  default, i vincoli CHECK, le colonne generate, gli indici e i tipi delle
  colonne delle tabelle che l'app ha appena toccato. Ammette solo le funzioni
  dell'elenco (`FUNZIONI_AMMESSE` in `lib/db/scripts/ruoli-regole.mjs`),
  quelle di operatori e conversioni di sistema, e i tipi di sistema o delle
  estensioni (un dominio con un suo CHECK, anche messo da un superutente, no);
  altrimenti «cerbero_app non può usare queste funzioni o tipi…» e il comando
  si annulla. Un'espressione di una tabella la
  esegue chi scrive la riga, una migrazione che cambia la colonna, il
  ripristino di un backup: senza questo controllo l'app poteva far girare SQL
  come superutente (la revisione lo ha riprodotto con un CHECK e
  `query_to_xml`).
  **Prima di migrare**, il migratore controlla le stesse espressioni su tutte
  le tabelle di Cerbero. Se ne trova una non ammessa **non migra**: il deploy
  fallisce e resta il container di prima. `ruoli.mjs --verifica` dice quale
  espressione e come toglierla.
- **Né riscritture delle tabelle del registro** (PR 2.10). Un terzo event
  trigger, `cerbero_ddl_dell_app_riscrive` (`table_rewrite`, stessa funzione),
  ferma l'app se riscrive una tabella sorvegliata dal registro delle
  modifiche: `ALTER COLUMN … TYPE … USING` o `SET EXPRESSION` cambierebbero i
  dati senza passare dai trigger. Lo crea il migratore; se manca o è spento
  `ruoli.mjs --verifica` lo dice, e il migratore lo rimette.
- **`cerbero_app` nasce senza accesso** (NOLOGIN, nessuna password). La password
  la dà chi gestisce il database, con `ruoli.mjs --imposta-password` (passo 3
  del rilascio); il migratore non tocca né la password né il LOGIN.
- **API e lavoratore all'avvio** scrivono con chi lavorano
  (`database: collegato come cerbero_app, lavora come cerbero_owner`). **Escono
  con 1**, e resta in servizio il container di prima, se:
  - il database rifiuta l'accesso (password, LOGIN, nome del database);
  - `cerbero_app` non lavora come `cerbero_owner`;
  - uno dei due event trigger (`cerbero_ddl_dell_app`,
    `cerbero_ddl_dell_app_fine`) manca o è spento;
  - una relazione del catalogo di Cerbero è ancora di un superutente.

  Ancora come `postgres` danno solo un avviso. Un avviso c'è anche per una
  relazione di un superutente fuori dal catalogo (per esempio un backup fatto
  a mano): l'app non la usa. Se all'avvio il database non risponde,
  riprovano ogni 15 s e giudicano quando la lettura riesce.
- **FleetCare.** Le sue funzioni che leggono Cerbero sono di
  `fleetcare_legge_cerbero`, che non è superutente e legge solo poche colonne
  di `public.users` e il nome dei depositi (FleetCare, migrazione 0089). Le
  colonne gliele ridà il migratore di Cerbero a ogni avvio (l'elenco è
  `LETTORI` in `lib/db/scripts/ruoli-regole.mjs`; dalla 2.12 c'è anche
  `mfa_obbligatoria`).
  `cerbero_owner` chiama solo `fleetcare.parco_per_avm()` e
  `fleetcare.interventi_avm()`.
  Il migratore segnala come errore ogni funzione SECURITY DEFINER di un
  superutente che legge tabelle di Cerbero: con le tabelle di `cerbero_owner`,
  l'app potrebbe farla girare con codice suo come superutente. **Finché c'è
  un errore così, `cerbero_app` non si usa.**
- **A mano**, dal Terminal del container dell'API:
  ```bash
  node lib/db/scripts/ruoli.mjs --verifica   # cosa non va, e chi è collegato con quale utente
  node lib/db/scripts/ruoli.mjs              # riallinea (senza tetto di tempo, lock fino a 5 s)
  node lib/db/scripts/ruoli.mjs --imposta-password  # password nuova a cerbero_app, e il suo DATABASE_URL già provato
  node lib/db/scripts/ruoli.mjs --prova-url  # prova un DATABASE_URL scritto a mano (lo chiede, non va scritto nel comando)
  ```
- **Chi lavora in psql.** Come `postgres`, per prima cosa
  `SET search_path = pg_catalog, pg_temp;`, poi solo cataloghi, permessi e
  ruoli. I dati delle tabelle di Cerbero si guardano e si correggono come
  `cerbero_app`. Le tabelle sono di `cerbero_owner`: un default o un vincolo
  messo lì dall'app non deve girare come superutente. Anche una copia di
  sicurezza di una tabella (`CREATE TABLE … AS`) si fa come `cerbero_app`:
  fatta come `postgres` resta di un superutente e la verifica la segnala.
- **Nessun programma scrive nelle tabelle di Cerbero da superutente.** Per
  esempio Caronte o il sistema AVM: ne eseguirebbe default e vincoli come
  superutente. `ruoli.mjs --verifica` dà errore per le sessioni da superutente
  dei programmi che non conosce.
- **Caronte e gli altri programmi.** Caronte entra come `caronte_app`
  (`caronte_setup.sql`, che si può rieseguire):
  - scrive solo `tap_events`, `journeys`, `vehicle_positions`, `active_trips` e
    `stop_transits`; legge le altre tabelle di `caronte` e le GTFS di `public`;
    non legge utenti, anagrafica, roster né il registro;
  - `caronte.app_users`, i suoi utenti, è una tabella sua: non è nel catalogo
    di Cerbero e ne è proprietario `caronte_app`;
  - **può creare nello schema `caronte`.** Serve a Caronte com'è oggi: a ogni
    login esegue `CREATE TABLE IF NOT EXISTS caronte.app_users`, e PostgreSQL
    lo rifiuta a chi non può creare nello schema anche quando la tabella c'è
    già. Non tocca le tabelle di Cerbero, che non sono sue; potrebbe però
    creare lì una tabella col nome che una migrazione vorrà usare. Per questo
    `ruoli.mjs --verifica` e il log dell'avvio lo ricordano con un avviso
    («caronte_app può creare tabelle e funzioni nello schema caronte»).
    Quando Caronte controllerà prima se la tabella esiste: si toglie la riga
    `GRANT CREATE` da `caronte_setup.sql` e, come `postgres`,
    `REVOKE CREATE ON SCHEMA caronte FROM caronte_app;`
  - **le sue tabelle non si scrivono da superutente.** Gli event trigger
    fermano solo l'app di Cerbero: da proprietario, Caronte può mettere su
    `caronte.app_users` un vincolo o un default qualunque, e lo eseguirebbe
    come superutente chi ci scrive come `postgres` o **ripristina un backup**.
    `ruoli.mjs --verifica` lo segnala con un avviso («caronte.app_users (di
    caronte_app, non di Cerbero): … usa …»), con l'istruzione per toglierlo:
    va guardato prima di un ripristino. Si chiude del tutto quando Caronte non
    farà più DDL: allora la tabella torna di `postgres` e a `caronte_app`
    restano lettura e scrittura;
  - nel suo servizio le variabili con l'URL del database sono **due**,
    `DATABASE_URL` e `CARONTE_URL`: vanno tutte e due su `caronte_app`. La
    seconda connessione nasce al primo login, anche settimane dopo l'avvio:
    se resta su `postgres`, l'errore della verifica torna allora.
- **L'API non cambia più lo schema** (PR 2.16a). Le funzioni che creavano
  tabelle, colonne e indici al primo uso non ci sono più: lo schema nasce solo
  dalle migrazioni, e un test guarda ogni sorgente dell'API. Resta una tabella
  temporanea di lavoro, che sparisce al COMMIT (import di Planning Studio).
  I **permessi** per farlo ci sono ancora, fino alla 2.16b: l'app possiede le
  sue tabelle, può crearne in `public`, e l'event trigger lascia passare
  `CREATE TABLE`, `CREATE INDEX` e `ALTER TABLE`. Dalla 2.10, su una tabella
  sorvegliata dal registro delle modifiche, l'app non può spegnere i trigger,
  rinominare o sostituire la tabella o le sue colonne, riscriverla
  (`ALTER COLUMN … TYPE`) né legarla per ereditarietà o come partizione. Può
  ancora, da proprietaria, cancellarne una colonna o toglierle l'espressione,
  o crearne di nuove non sorvegliate: lo chiude la 2.16b. Prima di
  aggiornare PostGIS si toglie il CREATE su `public` a `cerbero_owner`
  (README delle migrazioni).

**Rilascio (una volta sola), in quest'ordine:**
0. **Prima, in sola lettura**, dal Terminal del PostgreSQL
   (`psql -U postgres -d postgres`):
   ```sql
   -- chi è collegato e con che utente (anche Caronte e FleetCare)
   SELECT usename, application_name, count(*) FROM pg_stat_activity
    WHERE datname = current_database() GROUP BY 1, 2 ORDER BY 1, 2;
   -- di chi sono le relazioni di Cerbero
   SELECT n.nspname, pg_get_userbyid(c.relowner) AS proprietario, c.relkind, count(*)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'caronte', 'coda', 'cerbero_migrazioni') AND c.relkind IN ('r', 'v', 'S', 'p')
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
   -- schemi e database: proprietario e permessi
   SELECT nspname, pg_get_userbyid(nspowner), nspacl FROM pg_namespace
    WHERE nspname IN ('public', 'caronte', 'coda', 'cerbero_migrazioni', 'fleetcare');
   SELECT datname, pg_get_userbyid(datdba), datacl FROM pg_database WHERE datname = current_database();
   SELECT rolname, rolsuper, rolcanlogin FROM pg_roles
    WHERE rolname IN ('cerbero_owner', 'cerbero_app', 'caronte_app', 'fleetcare_app', 'argos_ro');
   ```
   - **Tabelle `caronte` di un ruolo diverso da `postgres`** (il sistema AVM):
     ci si ferma e si decide prima.
   - **Caronte (il validatore) o un altro programma entra come `postgres`**:
     va passato a `caronte_app`, o a un suo ruolo, **prima del passo 4**. È
     una condizione, non un consiglio. Le sue scritture su tabelle di
     `cerbero_owner` farebbero girare come superutente i default messi
     dall'app.

     Un programma che non dichiara il suo nome compare come «senza nome». Per
     sapere chi è, il suo indirizzo e poi il nome del container (il codice
     prima del trattino è quello del servizio nell'indirizzo della pagina di
     Coolify):
     ```sql
     SELECT client_addr, usename, count(*), min(backend_start), max(state_change) FROM pg_stat_activity WHERE backend_type = 'client backend' AND application_name = '' GROUP BY 1, 2;
     \! getent hosts <client_addr>
     ```
     Per Caronte, in quest'ordine:
     1. dal Terminal dell'API:
        `DATABASE_URL="$DATABASE_MIGRATOR_URL" node lib/db/scripts/run-sql.mjs caronte_setup.sql`
        (finché l'app entra come `postgres` basta
        `node lib/db/scripts/run-sql.mjs caronte_setup.sql`);
     2. in psql: `\password caronte_app`, poi `ALTER ROLE caronte_app LOGIN;`.
        Una password di sole lettere e cifre, lunga: non va codificata nell'URL;
     3. in Coolify, nel servizio di Caronte, `DATABASE_URL` **e** `CARONTE_URL`:
        cambiano solo utente e password
        (`postgresql://caronte_app:<password>@<host>:5432/<db>`). Poi Restart;
     4. si entra in Caronte e si rilancia la query qui sopra senza il filtro
        sul nome: quattro sessioni di `caronte_app`, nessuna di `postgres`
        senza nome. Se il login dà errore, il motivo è nel log di Caronte
        (`permission denied for …`); per tornare indietro si rimette l'URL di
        prima.

   **Nel Terminal di Coolify** quello che si incolla arriva su una riga sola:
   - prima si apre psql (`psql -U postgres`), poi si incollano le query, una
     per volta e scritte su una riga; un comando con la barra (`\password`,
     `\!`) va da solo sulla sua riga;
   - un file `.sql` con commenti non si incolla: si esegue con `run-sql.mjs`;
   - si esce con `\q`. Un terminale chiuso senza uscire lascia una sessione
     di `postgres` aperta.

   Poi sull'API: `DATABASE_MIGRATOR_URL` = l'URL di oggi (quello di
   `postgres`), lasciando `DATABASE_URL` com'è.
1. **Merge e deploy di API e lavoratore** (immagine nuova), la sera. Nel log
   dell'API:
   - `ruoli del database sistemati` e `N oggetti passati a cerbero_owner`;
   - gli **errori** sulle tre funzioni di FleetCare, che finiscono al passo 2;
   - l'avviso «collegato come postgres, superutente».

   Poi dal Terminal dell'API: `node lib/db/scripts/ruoli.mjs --verifica`.
   Restano solo FleetCare e l'avviso su `parco_per_avm`/`interventi_avm`.
   Finché Caronte (o un altro programma) entra come `postgres`, c'è anche
   l'errore «sessione da superutente di …»: va tolto, come detto al passo 0,
   prima del passo 4.
2. **FleetCare: merge della 0089 e deploy.** `ruoli.mjs --verifica` è pulita.
   Il login in FleetCare (da Cerbero) funziona e i dati dell'officina nell'AVM
   ci sono.
3. **La verifica e la password**, dal Terminal del container dell'API:
   - `node lib/db/scripts/ruoli.mjs --verifica` esce con 0, senza errori né
     «da fare» (se c'è qualcosa da fare: prima `node lib/db/scripts/ruoli.mjs`).
     Gli avvisi non fermano;
   - `node lib/db/scripts/ruoli.mjs --imposta-password`. In un passo:
     - genera una password (48 cifre e lettere, niente da codificare);
     - ne manda al database l'impronta, come `\password` di psql: la password
       non viaggia e non finisce nei log del server;
     - dà `LOGIN` a `cerbero_app`;
     - prova l'URL (collegato come `cerbero_app`, lavora come
       `cerbero_owner`, due event trigger accesi);
     - stampa il nuovo `DATABASE_URL`: quello del migratore con utente e
       password cambiati.

     **L'URL non si compone a mano.** Al primo rilascio la password scritta a
     mano è finita due volte nel posto sbagliato dell'URL, o diversa da quella
     data al ruolo. La riga stampata contiene la password: si copia solo nelle
     variabili dei due servizi. Il comando si rifiuta fuori da un terminale,
     chiede un superutente (dal container dell'API: `DATABASE_MIGRATOR_URL`) e
     si ferma **prima** di cambiare la password se i ruoli non sono in regola.

     A mano si può ancora: `\password cerbero_app` e
     `ALTER ROLE cerbero_app LOGIN;` in psql, poi
     `node lib/db/scripts/ruoli.mjs --prova-url` e si incolla l'URL
     (`postgres://cerbero_app:<password>@<servizio-db>:5432/<db>`, con la
     password codificata se ha `@ : / # %`).
4. **Coolify**, in quest'ordine:
   - API: `DATABASE_MIGRATOR_URL` = l'URL di oggi, quello di `postgres` (se
     manca si crea **prima**, copiando il valore di `DATABASE_URL`: senza, le
     migrazioni partirebbero come `cerbero_app` e l'API non si avvia);
   - API: `DATABASE_URL` = l'URL stampato al passo 3;
   - lavoratore: `DATABASE_URL` uguale a quello dell'API, nessun
     `DATABASE_MIGRATOR_URL`.

   Redeploy di tutti e due. Salvare le variabili non basta: valgono dal
   prossimo avvio. Se il container nuovo non parte (per esempio «password
   authentication failed»), Coolify lo toglie e **resta in servizio quello di
   prima**: il motivo è nel log del deploy. Poi di nuovo
   `ruoli.mjs --verifica`, dal Terminal del container nuovo.

   **Cambiare la password più avanti** (dopo una fuga, o di routine):
   `node lib/db/scripts/ruoli.mjs --imposta-password --anche-se-collegata`,
   e subito l'URL nuovo in `DATABASE_URL` dei due servizi e il redeploy. Fra
   il comando e il redeploy le connessioni nuove di API e lavoratore vengono
   rifiutate (quelle aperte restano): senza l'opzione il comando si ferma, per
   non farlo per sbaglio.
5. **Prove**:
   - `ruoli.mjs --verifica` mostra `collegati come cerbero_app` per
     `cerbero-api` e `cerbero-lavoratore`;
   - nel log c'è la riga `lavora come cerbero_owner`;
   - un calcolo nella Fucina, il Roster, AVM «Andamento» con i dati di
     FleetCare, una domanda ad Argos, un salvataggio in Planning Studio;
   - nel log nessun `permission denied`.

**Rollback:** `DATABASE_URL` di nuovo sull'URL di `postgres` (subito, senza
altro). Proprietari, ruoli ed event trigger possono restare: `postgres` resta
superutente e gli event trigger fermano solo `cerbero_app`. Per il container si
torna all'immagine di prima. Con l'immagine di prima, API e lavoratore entrano
come `postgres` senza nome di programma: in `ruoli.mjs --verifica` sono le
sessioni «senza nome», non un programma sconosciuto.

**Dopo un ripristino** (backup di Coolify o `pg_dump`):
- un dump non porta i ruoli. Il migratore li ricrea al primo avvio:
  `cerbero_app` torna NOLOGIN, quindi password e LOGIN vanno ridati (passo 3:
  `--imposta-password` stampa un URL nuovo, da mettere nei due servizi).
  Conviene salvare anche i ruoli (`pg_dumpall --roles-only`);
- un ripristino con `--no-owner` rimette tutto a `postgres`:
  - le relazioni di Cerbero le ripassa il migratore;
  - le tre funzioni di FleetCare che leggono Cerbero no. `ruoli.mjs --verifica`
    le segnala con l'`ALTER FUNCTION … OWNER TO fleetcare_legge_cerbero` da
    eseguire come `postgres`;
  - i permessi di `caronte_app` e la proprietà di `caronte.app_users` si
    ridanno con `caronte_setup.sql` (qui sopra, «Caronte e gli altri
    programmi»); poi la sua password, con `\password caronte_app`.
- un backup di prima della 2.12 non ha `users.mfa_obbligatoria`: finché l'API
  non riparte (il migratore riapplica la 0008) non entra nessuno. Dopo un
  ripristino si rifà sempre il deploy;
- un ripristino come `postgres` esegue i vincoli delle tabelle mentre carica
  i dati. Un backup fatto mentre `ruoli.mjs --verifica` non segnalava
  espressioni non ammesse è sicuro: con gli event trigger accesi l'app non
  può aggiungerne. Se la verifica ne segnala, prima si tolgono (la cura è nel
  messaggio) e poi si fa il backup;
- Prima di ridare `DATABASE_URL` a `cerbero_app`: di nuovo i passi 3 e 4.

Il container passa all'utente `node` con `setpriv`, che ha bisogno delle
capacità SETUID e SETGID: con `--cap-drop ALL` (non è il default di Coolify)
non parte.

### Registro delle modifiche (PR 2.10 e 2.11)

Chi ha cambiato che cosa, scritto dal database: trigger su 29 tabelle (21
della prima ondata, 8 della seconda) scrivono in `registro.modifiche`. L'app
non ha diritti sulle sue tabelle, salvo leggere l'elenco delle regole
(`registro.sorvegliate`): non lo cambia, non spegne i trigger, e lo legge solo
attraverso una funzione (sotto, «Leggerlo»). **Nasce spento**: non
scrive niente finché non lo accende chi gestisce il database (sotto).

**Cosa registra**, per ogni riga cambiata:
- chi: `attore` (l'id dell'utente), `via` (`api`, `argos:mcp`, `cron:…`,
  `coda:<tipo>`…), `richiesta`; da quale ruolo del database (`ruolo_db`, il
  solo che l'app non può falsificare) e da quale programma (`origine`);
- quando (`ts`) e in quale transazione;
- quale riga (`chiave`) e a che cosa appartiene (`ambito_tipo`/`ambito_id`:
  progetto, feed, utente, conducente…);
- i nomi dei campi cambiati (`campi`);
- i valori prima e dopo (`prima`/`dopo`) **solo** per programmi, orari, turni
  e tariffe (Planning Studio, Fucina, scenari, feed e prodotti tariffari,
  depositi, impostazioni), compresi i riferimenti fra loro (calendario,
  variante, progetto). Degli utenti, solo ruolo e permessi;
- che una password è cambiata (`password_cambiata_il`) e che la verifica in
  due passaggi è stata attivata o azzerata (`mfa_attiva`), solo come nomi.

**Cosa non registra:**
- i valori di anagrafica, roster e utenti: solo i nomi dei campi. Niente codici
  delle assenze, niente nomi; di una password o del segreto della verifica
  solo che è cambiato;
- le colonne di servizio (`updated_at`, `last_opened_at`, ultimo accesso,
  versioni della sessione, contatori della verifica): un login non scrive
  niente;
- i JSON pesanti (attributi, risultati dei calcoli) e i riferimenti alle
  persone (proprietario, chi ha aggiunto): solo il nome. Fa eccezione la
  riga di un membro di un programma: la sua chiave è l'identificativo del
  membro, che serve a dire di quale riga si parla.

Le regole di ogni tabella sono in `registro.sorvegliate`.

**La seconda ondata (2.11): gli orari di dettaglio di Planning Studio.**
- **Solo in riepilogo, senza valori**: gli orari alle fermate
  (`ps_stop_times`), le fermate delle varianti (`ps_variant_stops`), le
  eccezioni dei calendari (`ps_calendar_dates`). L'app li salva cancellando
  tutto e reinserendo una riga per fermata: una riga di registro per fermata
  sarebbe solo rumore. Il registro dice chi, quando, quale corsa (se
  l'operazione ne tocca una sola), quante righe e quali campi; **non dice
  l'orario di prima e quello di dopo**. Per averlo fermata per fermata serve
  un confronto a fine transazione: è lavoro a parte, da fare se serve alla
  rendicontazione.
- **Coi valori**, come la prima ondata: tracciati (`ps_shapes`, la geometria
  solo come nome), periodi di servizio, nodi di interscambio, zone vietate,
  attivazioni programmate.
- **Restano fuori, con il motivo:**
  - le tabelle della validità (`ps_trip_day_validity`,
    `ps_trip_category_validity`, `ps_validity_category_calendar`,
    `ps_trip_exceptions`, `ps_day_*`, `ps_calendar_profiles`): una
    sincronizzazione le riscrive anche quando qualcuno apre soltanto una
    pagina, e il registro attribuirebbe modifiche a chi ha solo letto;
  - le tariffe a zone (`gtfs_fare_areas`, `gtfs_fare_leg_rules`, i cluster):
    si rigenerano una riga per volta, fuori da una transazione.

  Prima vanno sistemate quelle scritture; poi entrano con una migrazione.

**Riepiloghi.** Più di 50 righe in un'istruzione, una cascata (cancellare un
progetto cancella le sue fermate), un'operazione in blocco (import GTFS e
anagrafica, generazione corse, fermate in blocco) o una tabella sempre in
riepilogo danno una riga per transazione, tabella e operazione: quante righe,
20 chiavi d'esempio, i campi toccati.
- si sommano **al COMMIT** (dalla 2.11): ogni istruzione accoda un parziale
  in `registro.parziali` e un trigger differito li somma una volta sola. Una
  transazione annullata, o un savepoint annullato, non lascia niente;
- `righe` somma le righe cambiate di ogni istruzione: due UPDATE sulle stesse
  60 righe danno 120;
- l'ambito (`ambito_id`) c'è solo se è lo stesso per tutte le righe, prima e
  dopo;
- casi limite: un `TRUNCATE … CASCADE` dà una riga per tabella senza
  `a_cascata`; un UPDATE che cambia la chiave primaria (l'app oggi non lo fa)
  dà la riga vecchia e la nuova.

**Anonimizzazione e conservazione** (`registro.impostazioni`):
- dopo 12 mesi (`anonimizza_dopo_mesi`, almeno 6) `attore` e `richiesta` si
  svuotano: resta che cosa è cambiato, non chi;
- dove chi ha fatto la modifica è anche la riga modificata (la propria
  password, la propria verifica), alla stessa scadenza si tolgono anche
  l'ambito e la chiave: altrimenti il nome resterebbe da un'altra parte;
- dopo 60 mesi (`conservazione_mesi`) le righe si cancellano;
- le consultazioni (`registro.letture`, sotto) si cancellano dopo gli stessi
  12 mesi;
- lo fa ogni giorno il lavoratore (`registro.manutenzione()`).

**Accenderlo è una decisione di Conerobus, non del codice.** Il registro
attribuisce le modifiche alle persone: è un controllo a distanza dell'attività
dei lavoratori (art. 4 c.1 dello Statuto dei lavoratori). Prima servono:
- un accordo con le RSU o l'autorizzazione dell'Ispettorato del lavoro;
- l'informativa a chi usa Cerbero;
- la DPIA, con i tempi di anonimizzazione e conservazione scelti.

Poi, come `postgres` dal Terminal del PostgreSQL:
```sql
-- prima: quanto si scrive oggi nelle tabelle sorvegliate (per stimare il volume)
SELECT relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables
 WHERE relid IN (SELECT tabella::regclass FROM registro.sorvegliate)
 ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC;
-- acceso: la base giuridica scritta è obbligatoria (un vincolo lo controlla)
UPDATE registro.impostazioni
   SET attivo = true, base_giuridica = 'accordo RSU del …; DPIA del …', attivato_il = now();
```
Per spegnerlo: `UPDATE registro.impostazioni SET attivo = false;`. Le righe già
scritte restano e seguono anonimizzazione e conservazione.

**Quanto costa** (Postgres 17, misure delle PR; tempi del solo database):
- spento: un UPDATE di una riga passa da 0,06 a circa 0,08 ms;
  un'istruzione su 10.000 righe +5–10%;
- acceso: un UPDATE di una riga circa 0,4 ms; 10.000 righe in
  un'istruzione +15–20% per INSERT, +30–40% per DELETE, +50–60% per UPDATE;
- acceso, gli orari di dettaglio (200 corse da 30 fermate, 6.000 righe):
  | | senza registro | acceso |
  |---|---|---|
  | salvati una riga per volta (6.200 istruzioni) | 0,1–0,3 s | 0,8 s |
  | spostati un orario per volta (6.000 UPDATE) | 0,2 s | 1,5–1,8 s |
  | importati a blocchi da 500 | 0,10 s | 0,11 s |
  | cancellati in cascata con le corse | 0,01 s | 0,02 s |

  Le operazioni fatte di migliaia di istruzioni da una riga pagano circa
  0,15–0,25 ms a istruzione, sempre uguali per quanto è lunga la transazione
  (provato fino a 40.000); quelle a blocchi quasi niente.

**Leggerlo** (dalla 2.11): la pagina **Amministrazione → Registro delle
modifiche** (`/admin/registro`), solo per l'admin.
- Si cerca per periodo (92 giorni al più), tabella, operazione e ambito: un
  programma, un feed, una corsa. **Non si cerca, non si ordina e non si conta
  per persona**: lo rifiutano la pagina, l'API e il database. Un utente o un
  conducente si possono vedere solo tutti insieme, mai uno per uno.
- Dalla più recente; dentro un'operazione, dall'ultima riga scritta alla
  prima. Ogni riga si apre sul prima e dopo, campo per campo, o sul campione
  di un riepilogo. I nomi dei conducenti non compaiono mai: del roster si
  vede l'identificativo.
- **Ogni consultazione viene annotata** in `registro.letture`: chi, quando,
  con quali filtri, quante righe. Va detto nell'informativa. Come per chi
  modifica, vale per i percorsi onesti: l'attore lo mette l'app. Finché il
  registro è spento e vuoto non si annota niente: non c'è niente da leggere.
  Un tentativo di cercare per persona non entra in `registro.letture` (la
  funzione lo rifiuta): resta nel log dell'API, coi nomi dei parametri.
- L'app non legge le tabelle del registro: chiama `registro.leggi()` e
  `registro.stato()`, che hanno i loro limiti e girano come il proprietario
  del registro. Agli agenti (Argos) la rotta è chiusa.

Da `postgres`, dal Terminal del PostgreSQL, si legge tutto:
```sql
SELECT ts, attore, via, operazione, chiave, campi, prima, dopo, righe
  FROM registro.modifiche
 WHERE tabella = 'public.ps_projects' AND ts > now() - interval '7 days'
 ORDER BY ts DESC LIMIT 50;
-- chi ha consultato il registro
SELECT ts, attore, via, filtri, righe FROM registro.letture ORDER BY ts DESC LIMIT 50;
```

**La verifica.** `node lib/db/scripts/ruoli.mjs --verifica` (e il migratore a
ogni avvio) dà errore, con la cura, se:
- un trigger del registro manca o non è acceso sempre (`ENABLE ALWAYS`);
- una tabella sorvegliata è legata per ereditarietà o come partizione, o una
  colonna nominata dalla sua regola non c'è più;
- un oggetto di `registro` non è di `cerbero_registro`, per esempio dopo un
  ripristino `--no-owner`;
- manca la partizione del mese, o ci sono righe nella partizione di riserva:
  `SELECT registro.manutenzione();` come `postgres` o come `cerbero_app`;
- ci sono riepiloghi non sommati in `registro.parziali` (una transazione
  chiusa senza la somma: non deve succedere): la stessa manutenzione li somma.

**Cosa non protegge:**
- un superutente (`postgres`) può tutto: spegnere i trigger e cambiare le
  righe. La verifica lo vede solo se lascia un trigger spento;
- `attore` e `via` li mette l'app sulla connessione (2.9): un'app compromessa
  può falsificarli, e può chiedere il riepilogo (modo «riepilogo») al posto
  delle righe coi valori: la modifica resta registrata, coi campi, ma senza
  prima e dopo. Fa fede `ruolo_db`;
- un'app compromessa può leggere il registro con `registro.leggi()` (entro
  i suoi limiti) e annullare la transazione per non lasciare la riga in
  `registro.letture`. Non può leggerne le tabelle, né cambiarle;
- una tabella nuova non è sorvegliata finché una migrazione non chiama
  `registro.sorveglia` (README delle migrazioni). La validità e le tariffe a
  zone sono fuori (sopra, «La seconda ondata»).

**Rilascio:** deploy normale. La 0006 e la 0007 creano i trigger con un lock
breve sulle tabelle sorvegliate: le letture continuano, le scritture
aspettano un attimo.
**Rollback:** immagine precedente. Schema e trigger restano; spenti non
scrivono niente.

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
`/tmp`. `tini` fa da processo 1. Il container parte come root solo per le
migrazioni (dalla 2.8): poi `docker/avvio.sh` passa a `node` con `setpriv`,
senza `DATABASE_MIGRATOR_URL`. Il Terminal di Coolify e l'HEALTHCHECK girano
come root. Al deploy Coolify manda il segnale di arresto
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
  **Dalla 2.6** nelle due corsie passano anche i turni macchina, il VCSP e i
  giri di Argos, che prima giravano subito dentro l'API, anche più d'uno
  insieme:
  - corsia veloce: CP-SAT fino a 3 minuti di budget (Rapida, Normale, la
    fattibilità di Argos, il «Ri-ottimizza» dell'area di lavoro) e turni guida
    fino a 2 minuti;
  - corsia lunga: VCSP, giri di Argos, CP-SAT Media e Massima, turni guida
    lunghi; **uno alla volta** con `LAVORI_SLOT_LUNGA=1`. Un VCSP dalla Fucina
    lanciato mentre gira un giro di Argos aspetta che il giro finisca (la
    pagina mostra solo l'attesa).
  Sul lavoratore a 3 CPU si consiglia `LAVORI_SLOT_VELOCE=2`: la fattibilità
  di Argos (che chiude dopo 420 s) non aspetta dietro un CP-SAT Normale. Per
  la corsia lunga `LAVORI_SLOT_LUNGA=2` solo se la memoria basta per due VCSP.
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
    deploy dell'API: 15 s di grazia (meno se `CERBERO_ARRESTO_SECONDI` è più
    corto), poi il calcolo si ferma e la risposta è 503 «rilancia il calcolo
    tra poco». Se l'API cade senza fermarlo, il lavoratore ferma da solo, dopo
    un minuto, il calcolo che nessuno aspetta più;
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
- **Sincronizzazione dei feed da Planning Studio** (dalla PR 2.7a). Anche la
  materializzazione di un progetto in un feed GTFS («Sincronizza con PS»
  dalla Fucina, la creazione di un progetto di esercizio, il giro di Argos
  con un'unità di produzione) è un lavoro `materializza_feed` in corsia
  veloce:
  - `POST /api/scheduling/projects/:id/sync-from-ps` accoda e risponde come
    prima (202, oppure con `?wait=1` il risultato entro 90 s); una seconda
    richiesta sullo stesso progetto si aggancia alla sincronizzazione in
    corso;
  - `GET …/sync-status` legge l'ultima sincronizzazione in coda: un deploy
    dell'API non la interrompe più, e non c'è più il falso «done» col feed
    vecchio dopo un riavvio;
  - l'ordine è cambiato: prima il feed nuovo, poi il puntatore del progetto,
    solo alla fine si cancella il feed vecchio, e solo se è un feed sintetico
    di Planning Studio fuori esercizio che nessuno usa più: non puntato da un
    progetto, da un'attivazione o da uno scenario dei turni di un altro
    progetto, senza tariffe, POI o classificazioni sopra, non letto da un
    calcolo vivo in coda (la stessa definizione delle pulizie,
    `lib/materializzazione/usi-feed.ts`). Gli scenari dei turni del progetto
    salvati sul feed vecchio restano col suo id, marcati «superati», come
    prima. Se il
    feed vecchio non si può cancellare (in uso, o un lock che non arriva in
    5 s) resta, e lo riprendono le pulizie. Un errore o uno stop a metà non
    lasciano feed parziali;
  - tempo massimo 30 minuti («fallito, scaduto»); uno stop che arriva dopo
    l'aggancio del feed nuovo non annulla più niente, e la sincronizzazione
    resta «completata»;
  - la sincronizzazione va nella corsia veloce, insieme a CP-SAT brevi e
    turni guida brevi: con `LAVORI_SLOT_VELOCE=2` (consigliato) non aspetta
    dietro a un calcolo. `agent-optimize` aspetta la sincronizzazione 20 s,
    poi risponde 409 «in corso» come prima;
  - `LAVORI_FEED_IN_CODA=0` sull'API la riporta dentro l'API, come prima (una
    sincronizzazione ancora viva in coda si segue, non se ne fa una seconda).
  «Metti in esercizio» resta sincrono nell'API.
- **I miei calcoli** (dalla PR 2.7a): `GET /api/lavori` dà gli ultimi 20
  calcoli in coda di chi chiede, di tutti gli ambiti (turni guida, turni
  macchina, giri di Argos, sincronizzazioni), con stato, avanzamento ed
  errore, senza risultato; `POST /api/lavori/:jobId/stop` ferma un proprio
  calcolo (agli altri, anche all'admin, 404). Permesso: Turni. La pagina e
  l'indicatore nella SPA arrivano con la 2.7b.
- **Pulizie** (dalla PR 2.7a, solo nel lavoratore e solo con lo schema del
  database «ok», ogni 6 ore, la prima 2 minuti dopo l'avvio; con più
  lavoratori le fa uno solo per volta):
  - i calcoli delle tariffe (matrice O/D minima, assegnazione dei nodi)
    rimasti «running» da oltre 24 ore, perché l'API è morta a metà,
    diventano «error» con «rilancialo»: niente più spinner infiniti;
  - i **feed sintetici orfani** (`ps-….synthetic`) più vecchi di 2 giorni si
    cancellano, al più 5 a giro, uno per riga nel log («feed sintetico orfano
    cancellato»). Orfano vuol dire: non attivo, non di default, non
    archiviato (un feed in esercizio sostituito resta), non in uso (non
    puntato da un progetto di scheduling o di Planning Studio, da
    un'attivazione o da uno scenario dei turni, senza tariffe, POI o
    classificazioni delle linee sopra, non letto da un calcolo vivo in coda;
    i parametri economici, che la scheda «Pianificazione» crea già leggendo,
    non contano). Senza un feed in esercizio
    (`is_active`) non si cancella niente. Un GTFS caricato a mano non si
    tocca: un file caricato col nome `ps-….synthetic` prende `.zip` in fondo.
    Per vedere prima quali sono i candidati (il lavoratore controlla in più
    le tabelle delle tariffe, dei POI e delle classificazioni e i calcoli in
    coda):
    ```sql
    SELECT f.id, f.filename, f.uploaded_at, f.trips_count
      FROM gtfs_feeds f
     WHERE f.filename LIKE 'ps-%.synthetic'
       AND NOT f.is_active AND NOT f.is_default AND f.archived_at IS NULL
       AND f.uploaded_at < now() - interval '2 days'
       AND NOT EXISTS (SELECT 1 FROM scheduling_projects x WHERE x.feed_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM ps_projects x WHERE f.id IN (x.materialized_feed_id, x.source_feed_id))
       AND NOT EXISTS (SELECT 1 FROM ps_pending_activations x WHERE x.feed_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM ps_activation_log x WHERE x.feed_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM service_program_scenarios x WHERE x.feed_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM planning_scenarios x WHERE x.baseline_feed_id = f.id)
     ORDER BY f.uploaded_at;
    ```
  - i giri di Argos rimasti «running» non si toccano: il loro stato vero lo
    dà già la coda.
- **Registro delle modifiche** (dalla PR 2.10, solo nel lavoratore e solo con
  lo schema «ok», ogni 24 ore, la prima 5 minuti dopo l'avvio; con più
  lavoratori lo fa uno solo per volta): `registro.manutenzione()` crea le
  partizioni del mese e dei due dopo, anonimizza e cancella le righe vecchie
  e le consultazioni scadute, somma i riepiloghi rimasti;
  poi i problemi di `registro.verifica()` vanno nel log come avvisi. Vedi
  «Registro delle modifiche» qui sopra.
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
   - `DATABASE_URL` e, se serve, `PGSSL_NO_VERIFY` uguali a quelle dell'API
     (dalla 2.8 l'utente è `cerbero_app`, vedi «Ruoli del database»);
   - `NODE_ENV=production`;
   - `LAVORI_SLOT_LUNGA=1`, `LAVORI_SLOT_VELOCE=2` (dalla 2.6; vedi «Slot»);
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
   pesante. Se si supera la memoria, il kernel uccide il processo più grande
   del container, cioè di solito il Python di quel calcolo: il container resta
   su, il calcolo finisce «fallito» con «Calcolo ucciso dal sistema (SIGKILL),
   probabilmente per memoria esaurita» e non si ritenta (con due calcoli
   insieme può toccare all'altro). Si riconosce anche da `dmesg` o dal
   contatore OOM del container. Se capita, si alza la memoria o si riduce il
   VCSP. Lo stesso budget su meno CPU dà soluzioni un po' peggiori: va
   guardato sui giri veri.
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
   artifacts/api-server/src/lib/materializzazione/**
   artifacts/api-server/src/lib/planning-studio-validity-eval.ts
   artifacts/api-server/src/lib/dati-solver.ts
   artifacts/api-server/src/lib/deadhead-matrix.ts
   artifacts/api-server/src/lib/geo-utils.ts
   artifacts/api-server/src/lib/scripts-dir.ts
   artifacts/api-server/src/lib/guardia-schema.ts
   artifacts/api-server/src/lib/identita-db.ts
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
     `scripts-dir.ts`), `OSRM_URL` se l'API ce l'ha, limiti 3 CPU e 3,5 GB,
     `LAVORI_SLOT_VELOCE=2`.
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

**Passare la sincronizzazione dei feed al lavoratore (PR 2.7a)**
0. **Prima del merge**, in Coolify:
   - sull'API `LAVORI_FEED_IN_CODA=0` e redeploy: l'API nuova sincronizzerà
     ancora dentro di sé, finché il lavoratore nuovo non è pronto;
   - sul lavoratore: le Watch Paths nuove (sopra:
     `artifacts/api-server/src/lib/materializzazione/**` e
     `artifacts/api-server/src/lib/planning-studio-validity-eval.ts`).
1. **Merge**, quando nessuno sta sincronizzando un progetto (una
   sincronizzazione nella memoria dell'API muore col deploy, come prima). Si
   ridistribuiscono API e lavoratore. Nel log del lavoratore, alla riga
   «Lavoratore dei calcoli avviato», `tipi` deve contenere
   `materializza_feed@1`.
2. **Accensione**, ancora senza sincronizzazioni in corso (nel log dell'API
   ogni «sync-from-ps» avviato ha il suo «completed» o «failed»): si toglie
   `LAVORI_FEED_IN_CODA` dall'API e la si ridistribuisce.
3. **Prova**: «Sincronizza con PS» dalla Fucina su un progetto con l'unità di
   produzione. Poi dal Terminal del PostgreSQL:
   ```sql
   SELECT stato, corsia, preso_da, errore, risultato->>'feedId' AS feed,
          finito_il - iniziato_il AS durata
     FROM coda.lavori WHERE tipo = 'materializza_feed'
    ORDER BY creato_il DESC LIMIT 5;
   ```
   `preso_da` comincia con `lavoratore:`, `feed` è il `feed_id` nuovo del
   progetto. Le pulizie partono 2 minuti dopo l'avvio del lavoratore: se
   cancellano feed orfani, lo dicono nel log.

**Tornare indietro (2.7a):** `LAVORI_FEED_IN_CODA=0` sull'API e redeploy (le
sincronizzazioni ancora in coda le finisce il lavoratore, e l'API le segue).
Per un revert del codice, prima si fermano le sincronizzazioni ancora vive
(la query della 2.6 con `WHERE tipo = 'materializza_feed' AND stato IN
('in_coda', 'in_corso')`): il lavoratore di prima non conosce quel tipo.

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
- **Per chi è obbligatoria lo dice il database** (PR 2.12, migrazione 0008):
  `users.mfa_obbligatoria` è una colonna calcolata da Postgres da ruolo e
  permessi, a ogni scrittura. Non si imposta a mano.
  - La leggono l'API di Cerbero e FleetCare (dalla sua migrazione 0090). Prima
    la regola era scritta nell'API e copiata a mano in una funzione di
    FleetCare.
  - **Per cambiarla basta una migrazione di Cerbero** che ridefinisce la
    colonna: né codice dell'API né FleetCare.
  - Il registro delle modifiche non la segna: cambia solo insieme a ruolo o
    permessi, che riporta già.
  - Da lei dipendono `role` e `permissions`: Postgres rifiuta di cambiarne il
    tipo, e toglierle chiede `CASCADE`, che toglie anche lei.
  - **L'API si fida della colonna solo finché è calcolata dal database.**
    L'app possiede `users` (fino alla 2.16): non può riscrivere la tabella,
    quindi né cambiare l'espressione né ricreare la colonna a modo suo, ma
    può toglierle l'espressione e scriverci, o toglierla. Allora:
    - colonna non più calcolata: per l'API la verifica diventa obbligatoria
      **per tutti**, FleetCare applica la regola di prima;
    - colonna tolta: l'API non autentica nessuno;
    - in tutti e due i casi `ruoli.mjs --verifica` e il log dell'avvio danno
      un errore con l'istruzione per rifarla (da eseguire come `postgres`,
      poi `node lib/db/scripts/ruoli.mjs` per ridare la lettura a FleetCare).
  - **Rilascio**: Cerbero e FleetCare in qualunque ordine. FleetCare usa la
    colonna quando c'è e la può leggere, altrimenti la regola di prima.
    **Rollback**: l'immagine di prima di Cerbero ignora la colonna, che può
    restare.
  - Per controllare: `SELECT email, role, mfa_obbligatoria, mfa_attiva FROM users ORDER BY 1;`
    (come `cerbero_app`).
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
| Amministrazione | Utenti e accessi (admin), Parametri di esercizio (admin), Registro delle modifiche (admin), Dati e integrazioni (Analisi o Esercizio), Sicurezza dell'account | — |

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
| `DATABASE_URL` | ✅ | `postgres://cerbero_app:pass@<servizio-db>:5432/dbname` (dalla 2.8; prima `postgres`) |
| `PGSSL_NO_VERIFY` | — | `1` se Postgres usa certificato self-signed |
| `DATABASE_MIGRATOR_URL` | ✅ dalla 2.8 | superutente (`postgres`), solo per le migrazioni e i ruoli all'avvio; l'API non la vede. Senza, vale `DATABASE_URL`, che dalla 2.8 è `cerbero_app`: il migratore si ferma |
| `CERBERO_ARRESTO_SECONDI` | — | attesa massima all'arresto per le richieste in corso (default 25, massimo 28: Coolify uccide il container dopo 30 s) |
| `CERBERO_PROCESSO` | — | `api` (default) o `lavoratore`: quale processo avvia l'immagine (vedi «Il lavoratore dei calcoli») |
| `CERBERO_LAVORATORE_INTERNO` | — | `0` spegne l'esecutore dei calcoli dentro l'API, quando c'è il lavoratore (default: acceso) |
| `LAVORI_SLOT_LUNGA` / `LAVORI_SLOT_VELOCE` | — | calcoli insieme per corsia, nel lavoratore e nell'esecutore interno (default 1 e 1) |
| `LAVORI_VEICOLI_IN_CODA` | — | `0` riporta turni macchina, VCSP e giri di Argos dentro l'API (rilascio della 2.6 e ritorno indietro); default: in coda, nel lavoratore |
| `LAVORI_FEED_IN_CODA` | — | `0` riporta la sincronizzazione dei feed da Planning Studio dentro l'API (rilascio della 2.7a e ritorno indietro); default: in coda, nel lavoratore |
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
