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
  vive come `gtfs_trips` a ogni materializzazione. Dalla PR 2.16a non ci sono
  più nemmeno le unità «pigre» che preparavano una tabella al primo uso, e
  dalla 2.16b il database lo vieta all'app («Ruoli del database»); un test
  (`migrazioni.test.ts`) guarda ogni sorgente dell'API. Le chiavi mancanti nei permessi degli utenti, che
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

### Chiavi esterne di Planning Studio (PR 2.15 e 2.15c)

Due tabelle non avevano la chiave verso il loro padre: le categorie di validità
delle corse (`ps_trip_category_validity.trip_id` → `ps_trips`) e le zone vietate
(`ps_no_go_zones.project_id` → `ps_projects`). Cancellando una corsa o un
progetto le loro righe restavano nel database, senza padre. L'import che
sostituisce le corse di un progetto, per esempio, le lasciava tutte.

Le migrazioni `0010` e `0011`, all'avvio dell'API:

1. mettono i due vincoli, con la cancellazione a cascata come le tabelle
   sorelle;
2. tolgono le righe già orfane. Nessuna pagina le può leggere: si arriva a loro
   solo dalla corsa o dal progetto, che non esistono più;
3. convalidano i vincoli.

Quante righe tolgono lo scrivono nel log del deploy, se sono più di zero:

```
[migrazioni] ATTENZIONE: 0010: tolte N righe di ps_trip_category_validity di corse che non esistono più …
[migrazioni] ATTENZIONE: 0010: tolte N zone vietate di progetti che non esistono più …
```

Per saperlo prima, in sola lettura dal Terminal del Postgres:

```sql
SELECT count(*) FROM ps_trip_category_validity v
 WHERE NOT EXISTS (SELECT 1 FROM ps_trips t WHERE t.id = v.trip_id);
SELECT count(*) FROM ps_no_go_zones z
 WHERE NOT EXISTS (SELECT 1 FROM ps_projects p WHERE p.id = z.project_id);
```

Dopo il deploy l'elenco delle categorie può accorciarsi: una categoria di
periodo (`scuole_chiuse_<periodo>`) senza più date, senza corse e senza unità
di progettazione viene tolta alla prossima sincronizzazione del calendario. Le
righe orfane la tenevano in vita per caso.

**La categoria: il terzo vincolo (migrazione 0013, PR 2.15c).** Fino alla PR
2.15b una categoria di validità in uso si poteva cancellare (Planning Studio ›
Validità › Categorie Periodi › Gestisci categorie): sulle corse che la usavano
restava una riga che punta a una categoria che non c'è più. Il calcolo tratta
quelle corse come legate a una categoria che non cade in nessun giorno: **una
corsa che aveva solo quella categoria non vale mai**, e non esce in quadri
orari, GTFS e turni.

Dalla 2.15b:

- **una categoria in uso non si cancella più.** L'API rifiuta finché la usano
  corse o unità di progettazione, e dice da quante. Va prima tolta da lì;
- **le corse già in quello stato si vedono.** Nella tabella Corse hanno il
  segno «categoria cancellata»; un avviso sopra la tabella dice quante sono e
  quante non valgono in nessun giorno, e «Mostra solo queste» le elenca da
  sole. Si sistemano selezionandole: «Giorni/Categorie» › «Sostituisci» ›
  «Applica categorie», con le categorie giuste o con nessuna (la corsa vale in
  ogni periodo). **Sistemarle cambia i giorni in cui valgono**: una corsa che
  oggi non esce mai tornerà a uscire. Va fatto guardando corsa per corsa.

Per sapere quante sono in tutti i progetti senza aprirli uno a uno, in sola
lettura dal Terminal del Postgres:

```sql
SELECT p.name AS progetto,
       count(DISTINCT v.trip_id) AS corse_con_una_categoria_cancellata,
       count(DISTINCT v.trip_id) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM ps_trip_category_validity v2
           JOIN ps_validity_categories c2 ON c2.id = v2.category_id
          WHERE v2.trip_id = v.trip_id)) AS di_cui_non_valgono_mai
  FROM ps_trip_category_validity v
  JOIN ps_trips t ON t.id = v.trip_id
  JOIN ps_projects p ON p.id = t.project_id
 WHERE NOT EXISTS (SELECT 1 FROM ps_validity_categories c WHERE c.id = v.category_id)
 GROUP BY p.name ORDER BY 2 DESC;
```

Dalla 2.15c la migrazione 0013 mette la chiave esterna anche sulla categoria
(`ps_trip_category_validity.category_id` → `ps_validity_categories`, senza
cascata): una categoria che non esiste non si scrive più su una corsa, e una
categoria usata da una corsa non si cancella nemmeno passando accanto all'API.

**La 0013 non può far fallire il deploy.** Se trova anche una sola corsa legata
a una categoria cancellata non tocca niente — quelle righe non le toglie, perché
toglierle cambierebbe i giorni in cui la corsa vale — non mette il vincolo, e
lo scrive nel log. Vale anche se una categoria in uso viene cancellata proprio
mentre la migrazione passa (dal container di prima, che durante il deploy serve
ancora): la migrazione aspetta che la cancellazione finisca, poi guarda.

```
[migrazioni] ATTENZIONE: 0013: N righe di ps_trip_category_validity puntano a una categoria cancellata: la chiave esterna sulla categoria NON è stata messa. …
```

Se nel log del deploy quella riga non c'è, il vincolo è al suo posto e non c'è
altro da fare. Se c'è:

1. si sistemano le corse dalla tabella Corse, come scritto sopra (la query qui
   sopra dice in quali progetti sono);
2. quando la query non restituisce più righe, il vincolo si mette a mano, come
   `postgres` dal Terminal del Postgres. Il comando controlla tutte le righe:
   se ne è rimasta una fallisce senza cambiare niente, e si riprova dopo averla
   sistemata.

   ```sql
   ALTER TABLE public.ps_trip_category_validity
     ADD CONSTRAINT ps_trip_category_validity_category_id_fkey
     FOREIGN KEY (category_id) REFERENCES public.ps_validity_categories(id)
     ON DELETE RESTRICT;
   ```

Finché il vincolo manca l'API lo ricorda nel log dopo ogni avvio, la prima
volta che qualcuno apre le categorie di validità (`manca la chiave esterna
sulla categoria delle corse …`, con il numero di corse ancora da sistemare), e
tutto funziona come prima della 2.15c: l'API rifiuta comunque le categorie
che non esistono e la cancellazione di quelle in uso. Per vedere se c'è:

```sql
SELECT conname, convalidated FROM pg_constraint
 WHERE conrelid = 'public.ps_trip_category_validity'::regclass AND contype = 'f';
```

Devono essere due righe, tutte e due con `convalidated = t`: la corsa (0010) e
la categoria (0013).

### L'azienda (PR 2.17a)

I dati dell'azienda che usa Cerbero erano scritti nel codice. Dalla migrazione
`0014` stanno nella tabella `public.azienda`, **una riga sola**, e si cambiano
da **Amministrazione › Azienda** (solo l'amministratore). Non è per più aziende
nello stesso database: ogni azienda ha la sua installazione, e questa è la sua
riga.

| Dato | Dove finisce |
|---|---|
| Ragione sociale | agenzia ed editore dei GTFS esportati dagli Scenari |
| Nome | intestazione dei documenti stampati (rapporti degli scenari, zonizzazione) |
| Sito | `agency_url` e `feed_publisher_url` dei GTFS (Scenari e Planning Studio) |
| Telefono | `agency_phone` dei GTFS esportati dagli Scenari |
| Identificativo GTFS | `agency_id` dei GTFS esportati dagli Scenari |
| Città, regione | etichetta nella barra laterale, pagina Traffico |
| Nome e città | parole che una password non può avere al centro («Conerobus2026!») |
| Centro e zoom | dove si aprono la mappa della pagina iniziale, la Mappa live e gli Scenari |

**Al rilascio su un'installazione in uso** (Conerobus) la migrazione scrive la
riga con i valori che erano nel codice: non cambia niente, con una eccezione
voluta. Il GTFS esportato da Planning Studio portava sempre l'indirizzo
segnaposto `https://example.com`; ora porta il sito del progetto, se c'è, o
quello dell'azienda. Il nome dell'agenzia in quel GTFS resta quello del
progetto, come prima.

**Su un'installazione nuova** (database senza utenti quando passa la 0014) la
tabella resta vuota: un'installazione nuova non nasce col nome di un'altra
azienda. Finché l'amministratore non compila la pagina, che lo dice in alto
(«Da compilare»), i GTFS escono come «Azienda di trasporto», le mappe si
aprono sull'Italia e nome e città non entrano nelle regole delle password.
È la prima cosa da fare dopo il primo accesso.

Da sapere:

- l'API tiene la riga in memoria per un minuto; chi la salva la fa rileggere
  subito. Nella web arriva con la sessione: chi è già dentro la vede al
  prossimo caricamento della pagina;
- il registro delle modifiche la sorveglia con i valori (sono dati
  dell'azienda, non di persone);
- i limiti dei campi stanno anche nei vincoli della tabella: un sito che non
  comincia con `http://` o `https://`, o un identificativo con una virgola,
  non si scrivono nemmeno da psql;
- il fuso orario non è fra i dati: resta `Europe/Rome` ovunque.

Per vederla dal Terminal del Postgres: `SELECT * FROM azienda;`.

**Cosa resta scritto nel codice**, per le prossime PR (servono a un'azienda
diversa da Conerobus, non a Conerobus):

- AVM: la regola «matricola di 1–4 cifre = vettura dell'azienda» e il nome nei
  testi per il centro di controllo;
- tariffe: le reti urbane, i prezzi minimi e la classificazione delle linee;
- intermodale e zone di coincidenza: stazioni, porto e aeroporto con i loro
  orari;
- territorio: i comuni ISTAT della provincia, le zone del traffico, le città
  del meteo;
- i depositi di partenza dell'anagrafica;
- alcune etichette e i centri delle mappe di singole pagine (intermodale,
  tariffe, orari).

### Codici stabili di corsa, fermata e linea (PR 3.1)

Una corsa, una fermata e una linea di Planning Studio hanno un **codice**:
obbligatorio, unico dentro il programma, e **lo stesso nelle copie del
programma**. L'id interno (un UUID) cambia a ogni copia e resta interno.

Da dove viene il codice:

| Riga | Codice |
|---|---|
| importata da un GTFS | l'id che aveva nel file (`stop_id`, `route_id`, `trip_id`) |
| creata a mano | lo dà il database: `CB-` più la lettera del tipo (`C` corsa, `F` fermata, `L` linea) e un numero che non si ripete, per esempio `CB-C1042` |
| copia di una corsa sdoppiata | un codice nuovo (`CB-C…`): è un'altra corsa |
| stesso id due volte nello stesso file | vale la prima riga, la seconda si salta (prima nascevano due righe, una delle quali senza orari o mai usata) |

Che cosa cambia per chi usa l'app:

- **Il GTFS esportato** da Planning Studio (Esporta GTFS) usa i codici come
  `stop_id`, `route_id` e `trip_id`. Prima consegnava gli id interni, che
  cambiavano a ogni copia del programma. **Il primo file esportato dopo questo
  rilascio ha identificativi diversi dai precedenti**; da lì in poi restano
  gli stessi, anche fra un programma e la sua copia. Per le righe importate
  da un GTFS sono gli id del file d'origine. Chi ha già ricevuto un file con gli
  id di prima va avvisato. `service_id` e `shape_id` restano id interni.
- **Rete** e **Corse** mostrano il codice al posto dei primi caratteri
  dell'id interno.
- **Reimportare un GTFS esportato da Cerbero** nello stesso programma
  (aggiornamento non distruttivo) ritrova ogni riga dal suo codice: non nascono
  doppioni. Le righe create a mano restano «a mano»: un aggiornamento dal file
  d'origine non le disattiva.

Che cosa **non** cambia ancora: il programma messo in esercizio (il feed che
leggono AVM, tariffe e turni) usa ancora gli id interni. È il passo
successivo.

**Le migrazioni.** La `0017` aggiunge la colonna e dà un codice a ogni riga che
c'è già; la `0018` lo rende obbligatorio e unico. Durante la migrazione le tre
tabelle restano chiuse: **misurati 13 secondi su 300.000 corse e 85.000
fermate** (16 col registro delle modifiche acceso); in quei secondi le pagine
di Planning Studio aspettano. Nel log del deploy:

- niente, se ogni riga importata ha tenuto l'id del suo file;
- `ATTENZIONE: 0017: N corse importate hanno preso un codice nuovo…`, se N
  righe importate non hanno potuto tenerlo: nel programma c'era già un'altra
  riga con lo stesso id (di solito la copia di una corsa sdoppiata), oppure
  l'id non va bene come codice (vuoto, più di 200 caratteri, caratteri di
  controllo). Non è un errore: quelle righe hanno un codice `CB-…`.

Per vedere i codici di un programma, dal Terminal del database:

```sql
SELECT pg_catalog.count(*) AS corse,
       pg_catalog.count(*) FILTER (WHERE codice = gtfs_id) AS col_codice_del_file,
       pg_catalog.count(*) FILTER (WHERE codice ~ '^CB-C') AS col_codice_nuovo
  FROM public.ps_trips
 WHERE project_id = '<id del programma>';
```

**Se si torna all'immagine di prima** (rollback): l'app funziona, perché ogni
riga nuova riceve il codice dal database. Due limiti, finché non si torna a
questa versione:

- «Sdoppia per validità» dà errore (il codice di prima copia anche il codice,
  che è unico);
- un GTFS importato con l'immagine di prima dà alle righe nuove codici `CB-…`
  invece degli id del file. Meglio non importare in quel periodo.

### Un solo programma in esercizio (PR 3.2)

Il **programma in esercizio** è il feed GTFS acceso: quello che leggono AVM,
tariffe, turni e le pagine dell'esercizio. Da questo rilascio lo si cambia da
**una porta sola**, e ogni cambio finisce nello **storico** (chi, quando, da
dove). Le strade per arrivarci restano tre:

| Da dove | Chi può |
|---|---|
| Planning Studio › **Metti in esercizio** (subito o con una decorrenza) | chi modifica il programma **e** ha «Pubblicazione degli orari» in scrittura (di partenza: il Pianificatore e l'amministratore) |
| il giro delle attivazioni programmate, alla decorrenza | chi le ha programmate |
| pagina GTFS › **Attiva** (un file caricato a mano) | solo l'amministratore, come prima |

Che cosa cambia:

- **C'è sempre un solo feed acceso, in tutta l'installazione.** Prima «Metti in
  esercizio» spegneva solo i feed dello stesso proprietario, e ne potevano
  restare due accesi (l'AVM prendeva l'ultimo caricato). Ora lo garantisce
  anche il database.
- **Lo storico non si perde più.** Prima «Metti in esercizio» lo scriveva «se
  riusciva», e «Attiva» non lo scriveva mai. Ora, se lo storico non si scrive,
  l'attivazione non avviene e resta in esercizio il programma di prima.
  L'attivazione immediata non spegne più il programma di prima prima di aver
  acceso il nuovo.
- **Lo storico resta anche se il progetto si cancella** (prima se ne andava
  col progetto).
- **Il feed in esercizio** si cancella (forzando) solo dall'amministratore, e
  nello storico il suo periodo si chiude.
- Chi non ha «Pubblicazione degli orari» in scrittura non vede più il pulsante
  «Metti in esercizio». Si cambia da Amministrazione › Ruoli.

**Le migrazioni.** La `0019` mette in regola lo stato di oggi **senza cambiare
il feed che legge l'AVM**:

- se ci sono più feed accesi, resta acceso quello che l'AVM legge già
  (l'ultimo caricato), e diventa anche quello di default; gli altri si spengono;
- nello storico restano aperti solo il periodo di quel feed, e se manca se ne
  apre uno da adesso (via `migrazione:0019`).

La `0020` aggiunge i due vincoli e mette lo storico nel registro delle
modifiche. Nel log del deploy:

- niente, se era già tutto in regola;
- `ATTENZIONE: 0019: spento il feed «…»`, per ogni feed che era acceso insieme
  a un altro. **Va guardato**: quel feed non era quello che leggeva l'AVM, ma
  qualcuno poteva crederlo in esercizio;
- `ATTENZIONE: 0019: chiusi N periodi dello storico…`, per i periodi rimasti
  aperti su feed non più in esercizio.

Per vedere lo storico, dal Terminal del database:

```sql
SELECT l.activated_at, l.deactivated_at, f.filename, l.via
  FROM public.ps_activation_log l LEFT JOIN public.gtfs_feeds f ON f.id = l.feed_id
 ORDER BY l.activated_at DESC LIMIT 20;
```

**Mentre il deploy gira** il container di prima serve ancora. Una sua «Metti
in esercizio» fallisce (e non cambia niente) se lascerebbe due feed accesi: è
il caso del feed in esercizio che appartiene a un altro utente. Meglio non
attivare programmi in quel minuto.

**Rollback**: immagine precedente. I vincoli restano, quindi vale lo stesso
limite: un «Metti in esercizio» quando il feed in esercizio è di un altro
utente fallisce. «Attiva» dalla pagina GTFS (amministratore) funziona sempre.
Se serve, i vincoli si tolgono come `postgres`:
`ALTER TABLE public.gtfs_feeds DROP CONSTRAINT gtfs_feeds_un_solo_in_esercizio;`
e `ALTER TABLE public.ps_activation_log DROP CONSTRAINT ps_activation_log_un_solo_aperto;`.

### Orari al pubblico dalla versione in esercizio (PR 3.3)

Stampa orari, quadri di palina, **mappa orari pubblica** (il QR alle paline) e
**mappa di rete condivisa** leggevano il programma di Planning Studio così
com'era in quel momento: una modifica di bozza finiva subito negli orari al
pubblico, anche se in esercizio c'era altro.

Da questo rilascio, quando un programma va in esercizio (o se ne programma la
messa in esercizio) Cerbero ne fa una **copia congelata**, la *versione
pubblicata*:

| Che cosa | Legge |
|---|---|
| link pubblici (mappa orari, mappa di rete) | la versione in esercizio del programma del link. **Gli stessi link e gli stessi QR**: cambia solo da dove leggono |
| Stampa orari (Orari al pubblico) | parte dalla versione in esercizio; si può scegliere quella programmata o la **bozza**, con un avviso giallo |
| la bozza | solo chi lavora sul programma (proprietario e membri) |

- Le versioni non compaiono fra i progetti e **non si modificano**, nemmeno
  dall'amministratore. Si lavora sul programma e lo si rimette in esercizio.
- Una versione programmata che si annulla o si sostituisce se ne va. Le
  versioni che sono state in esercizio restano: sono la storia di che cosa è
  stato pubblicato.
- La messa in esercizio dura qualche secondo in più: misurati **7,8 secondi in
  tutto** su un programma di 3.502 corse (materializzazione, copia, cambio).

**Il programma in esercizio oggi non ha ancora una versione**: finché non lo si
rimette in esercizio, link pubblici e stampa leggono il programma com'è, come
prima. Per congelarlo: Planning Studio › **Metti in esercizio** sul programma
già in esercizio (con «Pubblicazione degli orari» in scrittura). Da lì le
modifiche di bozza non arrivano più al pubblico.

Per vedere le versioni, dal Terminal del database:

```sql
SELECT v.name, v.created_at, f.is_active AS in_esercizio
  FROM public.ps_projects v LEFT JOIN public.gtfs_feeds f ON f.id = v.versione_del_feed
 WHERE v.versione_del_feed IS NOT NULL ORDER BY v.created_at DESC;
```

**Rollback**: immagine precedente. Le versioni restano nel database, senza
proprietario e quindi invisibili: i link e la stampa tornano a leggere il
programma com'è. La colonna `owner_user_id` resta facoltativa (solo per le
versioni, lo dice un vincolo).

### Il GTFS consegnabile (PR 3.4)

Il GTFS che si scarica da Planning Studio (pulsante «Esporta GTFS» sulla scheda
del programma) è quello che va a Regione, open data, fornitori di AVM e
bigliettazione. Da questo rilascio:

- **viene dalla versione in esercizio** del programma (la copia congelata della
  3.3), non dalla bozza. Se il programma non ha una versione in esercizio, dalla
  bozza, e il messaggio lo dice. Il nome del file dice quale
  (`gtfs_<programma>_esercizio_<data>.zip`);
- **ha l'azienda vera**: `agency.txt` e `feed_info.txt` prendono ragione
  sociale, identificativo GTFS, sito e telefono da **Amministrazione ›
  Azienda**. Prima l'azienda era «1» col nome del progetto. Senza i dati
  dell'azienda, quelli del progetto come prima;
- **è controllato prima di uscire**:
  - **errori** (il file non va consegnato: chi lo riceve lo scarterebbe):
    file obbligatori mancanti, identificativi doppi o che non tornano fra un file
    e l'altro, coordinate mancanti, orari non validi o che tornano indietro,
    corse con meno di due fermate, calendari senza date valide, azienda senza
    sito. L'export si ferma e dice quali; si correggono, oppure si sceglie
    **«Esporta comunque»**;
  - **avvisi** (il file è valido ma qualcosa non torna): fermate e linee senza
    corse, tratti percorsi a più di 120 km/h (orari o posizioni sbagliati),
    periodo del file già finito, calendari senza giorni. Il file si scarica, e
    il messaggio li riassume.

Sul programma di prova da 3.502 corse il controllo ha trovato 0 errori e 221
corse con almeno un tratto «a più di 120 km/h»: sono orari interpolati del file
d'origine (per esempio 13 secondi per 590 metri).

**Prima di consegnare**: in Amministrazione › Azienda devono esserci almeno
ragione sociale, identificativo GTFS e **sito** (senza sito il controllo si
ferma).

Il controllo non sostituisce il validatore ufficiale di chi riceve il file: ferma
gli errori più comuni prima che il file esca.

### Una sola funzione per i km programmati (PR 3.5)

Fino a qui i km dello stesso programma si contavano in tre modi diversi, e i
numeri non tornavano fra loro:

| Dove | Prima | Da questo rilascio |
|---|---|---|
| contatore km (in alto in Planning Studio) | lunghezza mandata dal browser | lunghezza calcolata dal server |
| km annui per categoria (stampa dell'elenco corse, Argos `ti_km`) | giorni della settimana del calendario × matrice, **senza periodo né eccezioni della corsa** | i giorni in cui la corsa circola davvero |
| km per comune (zonizzazione) | calendari settimanali, **senza matrice di validità** | i giorni in cui la corsa circola davvero |

**I giorni in cui la corsa circola davvero** sono gli stessi del GTFS in
esercizio e delle UDP: con la matrice di validità contano bollini, giorni della
settimana, categorie, eccezioni e **periodo** della corsa; senza matrice, i
calendari settimanali con le loro eccezioni (come il GTFS). La **lunghezza** è
quella del percorso disegnato, calcolata dal server.

**I numeri cambiano, e sui programmi importati da un GTFS di molto.** Alcuni
file danno a ogni corsa un periodo di un giorno solo (il giorno
dell'esportazione) e calendari con tutti i giorni spenti più quella data. Sul
programma di prova da 3.502 corse:

- prima: 2.329.597 km annui. Contavano solo i venerdì, perché il giorno
  dell'esportazione, il 5/12/2025, era un venerdì;
- adesso: 43.954,7 km, cioè le corse del 5/12/2025, l'unico giorno in cui il
  GTFS le fa circolare;
- con il periodo allargato fino al 31/12/2026 (prova su una copia): 11.865.481
  km. Sono tutti i feriali, perché la matrice importata dà a tutte le corse il
  «feriale». E la zonizzazione dà lo stesso numero: 703.147,6 km nel 2025 più
  11.162.333,5 km nel 2026.

Per questo le pagine lo dicono:

- nella stampa dell'elenco corse un avviso giallo conta le corse con un periodo
  di un giorno solo («Se devono circolare tutto l'anno, selezionale e allarga il
  Periodo»);
- il controllo del progetto ha un avviso nuovo, «Corse con un periodo di un
  giorno solo»;
- la risposta dei km annui ha il campo `periodoDiUnGiorno`.

Senza matrice di validità il periodo della corsa non entra nella circolazione
(non entra nemmeno nel GTFS), e l'avviso non compare.

**La migrazione `0022`** ricalcola dal tracciato, con la stessa formula del
server, la lunghezza dei percorsi già salvati (`ps_shapes.distance_m`). Sui
percorsi importati non cambia niente (meno di un metro). Cambiano i percorsi
disegnati a mano, che avevano la distanza del motore di instradamento mandata
dal browser. Per vedere prima del deploy quanti sono:

```sql
SELECT count(*) FROM ps_shapes WHERE mode <> 'driving' OR distance_m IS NULL;
```

**Dopo il deploy**: per i programmi importati che devono valere tutto
l'anno, selezionare le corse in Planning Studio › Corse e allargare il
«Periodo»; poi rifare «Metti in esercizio», perché anche il GTFS in esercizio
le fa circolare solo quel giorno.

**Rollback**: immagine precedente. Le lunghezze ricalcolate restano: sono più
giuste di quelle di prima, e la versione precedente le usa senza problemi.

### Turni macchina versionati e pubblicati coi turni guida (PR 3.6)

I turni guida si calcolano su un turni macchina: le loro vetture sono i suoi
blocchi. Fino a qui i turni guida pubblicati nel roster non si
sovrascrivevano (se ne creava una versione nuova), ma il loro turni macchina
sì. Salvato di nuovo, un giorno già pubblicato poteva ritrovarsi con vetture
diverse da quelle dei suoi turni guida.

Da questo rilascio:

- **Salvare un turni macchina i cui turni guida sono nel roster**
  (assegnati o pubblicati, anche nel passato) **crea una versione nuova**
  (v2, v3…), come per i turni guida:
  - i turni guida restano sulla versione su cui sono stati calcolati;
  - sulla nuova si calcolano i turni guida nuovi, da pubblicare per i giorni
    in cui devono valere;
  - la pagina dei turni macchina lo dice e da lì lavora sulla nuova versione.
- **Una versione superata non si modifica.** Si apre la più recente; nella
  lista degli scenari ha «c'è una versione più nuova».
- Rinominare, o salvare senza cambiare i turni, resta sullo stesso scenario.
- **Cancellando la versione nuova**, la precedente torna la più recente.
- L'aggiornamento automatico delle corse scoperte, quando si prendono corse
  da un'altra UDP, non crea versioni: se il roster usa quella fonte, la
  lascia com'è.
- **La pubblicazione registra anche il turno macchina di ogni giorno**
  (`roster_turni_pubblicati.vss_id`), accanto ai turni guida. Il database
  tiene la coppia coerente e non lascia cancellare un turno macchina
  pubblicato. Nell'anteprima, turni guida calcolati su una versione superata
  dei turni macchina hanno l'avviso «turni macchina con una versione più
  nuova».

**Le migrazioni**:
- la `0023` scrive su ogni riga del canale il turno macchina dei suoi turni
  guida;
- la `0024` lo rende obbligatorio, coerente e non cancellabile.

Tabelle piccole: un attimo di lock. Il nome della tabella resta
`roster_turni_pubblicati`.

**Durante il deploy**, fra la migrazione e l'avvio della nuova API, una
pubblicazione fatta dalla versione vecchia si ferma (le manca il turno
macchina): basta rifarla.

**Dopo il deploy** non c'è niente da fare. Chi ha turni guida nel roster e
salva il loro turni macchina vede nascere la versione 2.

**Rollback**: immagine precedente. La colonna e i vincoli restano. La versione
precedente pubblica senza scrivere `vss_id`, che è obbligatorio: **la
pubblicazione dei turni guida si fermerebbe**. Con il rollback, quindi, si
toglie anche l'obbligo (come `postgres`):

```sql
ALTER TABLE roster_turni_pubblicati ALTER COLUMN vss_id DROP NOT NULL;
ALTER TABLE roster_turni_pubblicati DROP CONSTRAINT roster_turni_pubblicati_coppia;
```

Le versioni dei turni macchina già create restano scenari normali.

### Diagnosi dell'esercizio (tappa 4)

Prima di congelare il programmato di ogni giornata (il servizio del giorno)
vanno prese due decisioni aperte dell'analisi:
- **la chiave della corsa** fra programma e AVM;
- **che cosa fa fede come programmato**: il feed in esercizio o i turni
  pubblicati.

Per prenderle servono i numeri veri. Li dà la pagina **Amministrazione ›
Diagnosi dell'esercizio** (solo amministratore, sola lettura; l'API è
`GET /api/admin/esercizio/diagnosi?giorno=AAAA-MM-GG`).

Per una giornata (dalle 03:00 alle 03:00) dice:

- **il programma e il feed in esercizio all'inizio della giornata**, dallo
  storico delle attivazioni. Non il feed acceso oggi: il passato non si conta
  sul presente. Dice anche il feed su cui aggancia l'AVM oggi, e se è lo
  stesso;
- **le corse programmate**, con la regola del calendario dell'aggancio
  (settimana nel periodo, meno le date tolte, più quelle aggiunte), e i
  **numeri di corsa che si ripetono** nel giorno;
- **quante corse si riconoscono nelle prove dell'AVM** (coppie di codici e
  passaggi alle fermate di quella giornata), e in che modo:
  - **per id**: il feed dell'AVM è quello del programma;
  - **per codice stabile**: l'id del file d'origine, che Planning Studio
    conserva;
  - **per numero di corsa**: solo se il numero è unico nel giorno;
- **i viaggi dell'AVM che non si riconducono a nessuna corsa** del programma:
  corse aggiunte, o un feed diverso;
- **le corse senza geometria** e i km del giorno dalla geometria, accanto a
  quelli dell'analisi del feed;
- **i turni pubblicati della giornata**:
  - se ci sono e se sono del programma in esercizio;
  - quanti turni guida e turni macchina hanno una versione più nuova;
  - quante corse restano fuori dalle UDP pubblicate.

**Dopo il deploy**: apri la pagina su tre giornate vere di ottobre (un feriale
scolastico, un sabato, una domenica) e annota i numeri. Con quelli si decide:
- la chiave della corsa (decisione aperta 2);
- se il programmato contrattuale è il feed o sono i turni pubblicati
  (decisione aperta 3).

Nessuna migrazione, nessuna scrittura.

### Giornate di esercizio: il programmato congelato (tappa 4.2)

Il programmato di un giorno si ricalcolava ogni volta dal feed acceso oggi: il
passato cambiava col presente. Da questo rilascio ogni giornata di esercizio
(dalle 03:00 alle 03:00) ha la sua **istantanea**, che non cambia più dopo
l'inizio della giornata. È la base del consuntivo.

- **Il programmato è il feed in esercizio all'inizio della giornata**, preso
  dallo storico delle attivazioni (la porta unica della 3.2), non il feed
  acceso oggi. È la proposta dell'analisi per la decisione aperta 3. I turni
  pubblicati si aggiungono dalla 4.3 (sezione sotto); dove divergono, lo
  dicono gli avvisi.
- **Ogni corsa ha tre identità**:
  - la chiave del feed (l'id della corsa di Planning Studio);
  - il codice stabile;
  - il numero di corsa.

  Così la chiave per le prove dell'AVM (decisione aperta 2) si sceglie quando
  si collegano le prove, coi numeri della diagnosi.
- **Ogni corsa ha anche** linea, percorso, direzione, orari (anche oltre le
  24:00), capolinea, «a chiamata» e i km dalla geometria del feed, calcolati
  dal server.
- **Il lavoratore**, ogni 15 minuti:
  - prepara la giornata di domani, e la rifà a ogni giro finché non comincia;
  - alle 03:00 la **congela**: da lì una nuova messa in esercizio, una duplica
    o un feed caricato dopo non la toccano.
- **Una giornata passata** si può preparare a mano: nasce congelata e
  «ricostruita», col programma dello storico di quel giorno.
- **Senza un programma nello storico** (le giornate prima della porta unica) la
  giornata resta vuota, e lo dice: non si ripiega sul feed di oggi.
- **Il feed di una giornata** conta come «in uso»: le pulizie del lavoratore
  non lo cancellano.

**La pagina: Amministrazione › Giornate di esercizio** (solo amministratore,
per ora):
- l'elenco degli ultimi 30 giorni e di domani;
- per ogni giornata programma, feed, stato, avvisi e corse;
- «Prepara» per una giornata che manca.

L'API è `GET /api/admin/esercizio/giornate`,
`GET /api/admin/esercizio/giornate/:giorno` e
`POST /api/admin/esercizio/giornate/:giorno/prepara`.

**La migrazione `0025`** crea `esercizio_giornate` ed `esercizio_corse`,
tabelle nuove. Il registro delle modifiche non le sorveglia, perché le scrive
solo il sistema; il giornale del consuntivo avrà il suo.

**Dopo il deploy**:
1. Aggiorna le **Watch Paths del lavoratore** in Coolify con le righe nuove
   del blocco più sotto (`esercizio-*.ts`, `service-day.ts`,
   `km-programmati.ts`, `siri-vm.ts`, `parco-anagrafica.ts`), poi ridistribuisci
   il lavoratore.
2. Entro 15 minuti nel log del lavoratore compare «giornate di esercizio:
   preparate e congelate», e nella pagina ci sono oggi e domani.
3. Confronta il numero di corse di una giornata con «Corse programmate» della
   copertura AVM dello stesso giorno, quando il feed è lo stesso.

**Rollback**: immagine precedente. Le tabelle restano, ferme; la versione di
prima non le usa.

### Turni nel programmato (tappa 4.3)

L'istantanea di una giornata dice quali corse sono programmate. Da questo
rilascio dice anche **chi le porta**:
- **Per ogni corsa**: il turno macchina, il turno guida e il deposito.
- **Da dove**: dai turni pubblicati nel roster (Pubblicazione › Turni al
  roster) **com'erano all'inizio della giornata**, alle 03:00. Il canale tiene
  lo storico, quindi una pubblicazione o un ritiro fatti dopo non cambiano una
  giornata cominciata.
- **Perché bastano i turni guida**: ogni turni guida pubblicato punta ai turni
  macchina su cui è calcolato, che quindi sono pubblicati con lui. Da quando
  sono pubblicati i turni non si sovrascrivono (3.6): chi li salva ne crea una
  versione nuova.

Le corse dei turni si riconoscono:
- **per id**, quando i turni sono calcolati sullo stesso feed della giornata;
- **per codice stabile della corsa**, quando sono calcolati su un'altra copia
  del programma.

Un codice ripetuto nella giornata non riconosce niente: la corsa resta
scoperta, piuttosto che finire sulla corsa sbagliata.

**Turni macchina della giornata.** Per ognuno: deposito, mezzo, uscita,
rientro, corse e **vuoti programmati**.
- I km a vuoto sono il totale del turno salvato dal calcolo. Comprende anche i
  rientri intermedi in deposito, che non hanno i km sulla singola voce.
- La somma della giornata si confronta col riepilogo salvato del calcolo. Se
  non torna, c'è un avviso.
- Dai turni si prendono solo l'appartenenza delle corse e i vuoti. I km in
  linea restano quelli della geometria (3.5).

**Il riepilogo della giornata:**
- che cosa è pubblicato: UDP, turni guida e turni macchina;
- le corse senza turno macchina e perché:
  - fuori dalle UDP pubblicate;
  - lasciate scoperte dal calcolo dei turni macchina;
  - non comprese nel calcolo, per esempio linee non scelte;
- le corse col turno macchina ma senza turno guida;
- le corse dei turni che il programmato non ha;
- i turni superati, o calcolati su dati poi cambiati;
- le UDP di un programma diverso da quello in esercizio.

Gli avvisi lo dicono in parole.

**Le giornate già congelate dalla 4.2** non hanno i turni:
- il lavoratore li aggiunge una volta sola, dallo storico del canale, a
  partire dalle più recenti (31 per giro);
- le loro corse non cambiano;
- dalla pagina lo fa «Aggiungi i turni ora».

**La pagina: Amministrazione › Giornate di esercizio**:
- il riquadro «Turni pubblicati», con l'elenco dei turni macchina (il
  dettaglio dei vuoti è nel suggerimento dei km a vuoto);
- nelle corse, le colonne turno macchina, turno guida e deposito, anche nel
  filtro;
- «Per turno macchina» mette in fila le corse di ogni turno.

**La migrazione `0026`**:
- aggiunge le colonne dei turni a `esercizio_corse` e il riepilogo `turni` a
  `esercizio_giornate`;
- crea `esercizio_turni_macchina`.

Gli id dei turni sono una fotografia, come il nome del programma: niente
chiavi esterne.

**Dopo il deploy**:
1. Le Watch Paths del lavoratore non cambiano: il file nuovo
   (`esercizio-turni.ts`) è già coperto da `esercizio-*.ts`, se la 4.2 è
   stata aggiunta. Il lavoratore si ridistribuisce da solo.
2. Entro 15 minuti nel log del lavoratore compare «giornate di esercizio:
   preparate e congelate». Le giornate della 4.2 risultano «congelata, turni
   aggiunti».
3. In una giornata con i turni pubblicati, controlla nella pagina:
   - le corse col turno macchina;
   - i km a vuoto contro «riepilogo del calcolo»;
   - le scoperte, giustificate da «non comprese nel calcolo» e dalle UDP.

**Rollback**: immagine precedente. Colonne e tabella restano, ferme; la
versione di prima non le usa.

### La proposta dall'AVM (tappa 4.4)

Per ogni corsa di una giornata cominciata (congelata), l'esito che le prove
dell'AVM suggeriscono, con le prove accanto. È una **proposta**: la conferma è
di una persona (giornale e conferma, la tappa successiva).

**Una corsa senza prove resta «non rilevata»: non diventa mai «soppressa» da
sola.** In un giorno di ottobre l'AVM vedeva il 16,7% delle corse, e
dall'assenza di prove non si deduce l'assenza della corsa. Che cosa ne sarà
delle non rilevate alla chiusura è la decisione aperta 1 (presunzione di
effettuazione o prova obbligatoria).

**Come si riconosce la corsa dell'AVM** (decisione aperta 2, presa coi numeri
della diagnosi di ottobre: per id 517, per numero 508, per codice 0):
1. per id del feed;
2. per codice stabile, quando l'AVM aggancia un altro feed dello stesso
   programma;
3. per numero di corsa, solo se unico nella giornata.

**Le proposte**, nell'ordine in cui si provano:
- **Effettuata (AVM)**: una sola vettura, e prima e ultima fermata osservate,
  oppure almeno il 70% delle fermate.
- **Parziale?**: partenza osservata, ultima fermata vista ad almeno 3 fermate
  dalla fine, e la vettura che passa a un'altra corsa prima dell'arrivo
  programmato o non si vede più.
- **Per continuità**: nessuna prova contraria, e la stessa vettura effettua la
  corsa precedente e la successiva dello stesso turno macchina (4.3).
- **Da verificare**: qualche prova, ma non basta (più vetture, poche fermate,
  solo il viaggio dichiarato senza passaggi).
- **Soppressa?**: nessuna prova, e il turno guida della corsa non ha
  conducente nel roster della giornata. Vale solo dove il roster ha
  assegnazioni per quei turni guida.
- **Non rilevata**: nessuna prova.

Le soglie (70%, 3 fermate) sono la decisione aperta 6: sono valori di
partenza, scritti nel riepilogo di ogni proposta.

Contano solo le righe di **SIRI**: il sistema AVM scrive le proprie nelle
stesse tabelle, con altri codici.

**Le candidate corse aggiunte** sono i viaggi dell'AVM che non si
riconducono a nessuna corsa del programmato, con linea, partenza, numero e
vetture. Fra queste ci sono anche i codici `FRSRV…`: probabilmente movimenti
fuori servizio, da guardare prima di confermarli come corse.

**Quando si fa**:
- **definitiva**: il lavoratore la fa per le giornate degli ultimi tre giorni,
  dopo le 04:00 del giorno dopo, quando i passaggi tardivi sono arrivati;
- **durante la giornata**: a richiesta, dalla pagina («Calcola la proposta»,
  «Ricalcola»). È una vista viva;
- è idempotente, con lo stesso lucchetto della giornata.

**La pagina: Amministrazione › Giornate di esercizio**, riquadro «Proposta
dall'AVM»:
- i conteggi per proposta, che filtrano le corse;
- la copertura e come sono state riconosciute le corse;
- le candidate aggiunte.

Nelle corse c'è la colonna «Proposta»; il suggerimento spiega le prove.

**La migrazione `0027`**:
- aggiunge `proposta` e `prove` a `esercizio_corse`, con un vincolo sui valori;
- aggiunge il riepilogo `proposta` a `esercizio_giornate`;
- crea `esercizio_aggiunte_proposte`.

**Dopo il deploy**:
1. Le Watch Paths del lavoratore non cambiano: `esercizio-proposta.ts` è
   coperto da `esercizio-*.ts`.
2. Dopo le 04:00 del giorno dopo, nel log del lavoratore compare
   «giornate di esercizio: proposta dall'AVM».
3. La definizione di fatto dell'analisi, su giorni veri:
   - la distribuzione delle proposte su cinque giorni;
   - la quota di «non rilevate», da confrontare con 1 meno la quota di corse
     della copertura AVM;
   - 50 «effettuate (AVM)» controllate a mano con la prova del percorso:
     nessun falso positivo.

**Rollback**: immagine precedente. Colonne e tabella restano, ferme; la
versione di prima non le usa.

### Il consuntivo: giornale e conferma degli esiti (tappa 4.5)

La proposta dall'AVM suggerisce; da qui **decide una persona**. Ogni
decisione è un **evento del giornale**, con autore, ora e fonte (Centrale,
deposito, ufficio movimento). Il giornale è solo in aggiunta: un evento
sbagliato si annulla con un altro evento, e le corse tornano com'erano.

**La pagina: Esercizio › Consuntivo** (area «Consuntivo» dei ruoli).
- **Chi la usa.** Nella matrice di partenza scrivono la Centrale operativa e
  l'Amministrazione; Pianificatore, Ufficio turni e Capo deposito leggono;
  l'Officina no. L'amministratore cambia la matrice da Amministrazione ›
  Ruoli. I token di servizio (Argos) leggono e non scrivono.
- **La conferma è per eccezione**:
  - in blocco le corse «Effettuata (AVM)» e quelle «Per continuità»;
  - poi il resto, a gruppi: effettuate, da verificare, soppresse (con la
    causale), parziali (con la causale e, se si sanno, i km fatti).
- **Km effettivi**: effettuata = programmati, soppressa = 0, parziale =
  quelli detti. Se non si sanno restano vuoti, e si calcoleranno coi
  progressivi alle fermate.
- **Corse aggiunte** (bis, recupero, sostitutiva, fuori programma): dalle
  candidate dell'AVM, una volta sola, o a mano.
- **Note** sulla giornata o sulle corse.
- **Annullamento** di un evento: solo se nessun evento dopo ha toccato le
  stesse corse (prima si annulla quello).
- **Due persone sulla stessa giornata**: chi salva per secondo riceve «la
  giornata è cambiata» e la pagina si ricarica (versione della giornata).

**Le causali** (decisione aperta 5). C'è un catalogo iniziale:
- guasto del mezzo, sinistro e mancanza di personale, imputabili
  all'azienda;
- sciopero, traffico, meteo, ordine dell'autorità e manifestazione, non
  imputabili;
- altro, imputabile.

L'amministratore lo cambia in fondo alla pagina: imputabilità, codice per
l'ente, attiva o no, causali nuove. Il codice di una causale non cambia,
perché le corse lo citano. **Da fare: il codice per l'ente di ogni causale,
quando si sa.**

**L'annullamento dell'AVM** (SIRI, `VehicleActivityCancellation`), che prima
non lasciava traccia, diventa un evento del sistema, una volta per corsa e
giornata. Nella proposta è un indizio di soppressione («Soppressa?»): non
diventa mai un esito da solo.

**La migrazione `0028`**:
- crea `esercizio_causali`, col catalogo iniziale scritto come
  `cerbero_owner`, senza toccare quello che c'è;
- crea `esercizio_eventi`: una giornata con eventi non si cancella, e un
  evento si annulla una volta sola;
- aggiunge a `esercizio_corse` l'esito confermato, i km effettivi, la
  causale, la vettura, la nota, chi e quando, e le corse aggiunte;
- aggiunge a `esercizio_giornate` la versione.

Il giornale fa da registro del consuntivo: il registro delle modifiche non
sorveglia queste tabelle, che il lavoratore riscrive a ogni giro.

**Dopo il deploy**:
1. Nessuna Watch Path nuova: il lavoratore non usa il giornale.
2. Dai ruoli giusti alle persone dell'ufficio movimento e della Centrale
   (Amministrazione › Utenti e accessi).
3. La definizione di fatto dell'analisi: l'ufficio movimento consuntiva un
   giorno vero dall'inizio alla fine, e ogni modifica compare nel giornale
   con autore e momento.

**Sicurezza e lavoratori**: il giornale registra chi ha confermato che cosa,
cioè un'attività del personale d'ufficio. Vale quanto deciso per il registro
delle modifiche (art. 4 dello Statuto, informativa): va detto alle persone
che lo usano.

**Rollback**: immagine precedente. Tabelle e colonne restano, ferme; la
versione di prima non le usa.

### Chiusura e blocco del consuntivo (tappa 4.6)

Decisioni del 16/11/2026:
- **Le corse senza prove dell'AVM** si chiudono con la **presunzione di
  effettuazione salvo segnalazione** (decisione aperta 1). È un esito a sé,
  «presunta», distinto dalle effettuate provate: nel report si vede quanto
  è provato e quanto è presunto.
- **La giornata la chiude chi ha il ruolo Amministrazione** (o
  l'amministratore di sistema). La Centrale registra gli esiti ma non chiude.
- **Riaprire una giornata, chiudere e riaprire un mese** spettano solo
  all'amministratore di sistema, con un motivo che resta scritto.
- **Nessun blocco automatico a tempo**: la pagina segnala in giallo le
  giornate cominciate e ancora aperte dopo tre giorni («da chiudere»).

**La giornata.** In Esercizio › Consuntivo:
- «Presumi effettuate le non rilevate» conferma in blocco come «presunta»
  le corse senza prove (comprese quelle senza proposta, nelle giornate senza
  AVM);
- «Chiudi la giornata» funziona quando la giornata è finita (dopo le 03:00
  del giorno dopo) e non ha corse da decidere, da verificare, o parziali
  senza i km fatti. Altrimenti dice che cosa manca;
- alla chiusura il **riepilogo si congela**: corse per esito, km
  programmati, effettivi, persi e aggiunti, per linea e per causale.

Da quel momento **ogni scrittura risponde 409**: eventi, proposta, turni.
L'amministratore la riapre col motivo, che va nel giornale. Riaprirla e
richiuderla senza modifiche dà lo stesso riepilogo.

**Il mese** (riquadro in fondo alla pagina, solo l'amministratore):
- si chiude quando è finito e tutte le sue giornate sono chiuse;
- i giorni senza giornata (prima del rilascio della 4.2, o mai preparati)
  restano scritti nel riepilogo come mancanti;
- chiuso, il riepilogo del mese si congela e le sue giornate non si
  riaprono;
- si riapre col motivo, e la storia di chiusure e riaperture resta.

**La migrazione `0029`**:
- l'esito «presunta»;
- lo stato «chiusa» della giornata, con chi, quando e il riepilogo;
- gli eventi di chiusura e riapertura;
- la tabella `esercizio_mesi`.

**Dopo il deploy**:
1. Dai il ruolo **Amministrazione** a chi chiude le giornate.
2. La definizione di fatto: una giornata chiusa risponde 409 a ogni
   scrittura; riaprirla e richiuderla senza modifiche riproduce gli stessi
   totali.

**Rollback**: immagine precedente. La versione di prima non conosce lo stato
«chiusa» né l'esito «presunta»: prima di tornare indietro riapri le giornate
chiuse, se no restano fuori da ogni scrittura.

### Il report mensile del consuntivo (tappa 4.7)

Decisioni del 16/11/2026, in attesa del modello dell'ente:
- **Un report standard del mese**, in XLSX (riepilogo, indicatori,
  ripartizioni) e in CSV (il dettaglio corsa per corsa, per le
  contestazioni).
- **Indicatori**:
  - regolarità **lorda**: corse effettuate (provate e presunte) sulle
    programmate, e km effettivi sui programmati;
  - regolarità **netta**: lo stesso, togliendo dal programmato le
    soppressioni e le parziali con causale non imputabile all'azienda (e i
    loro km);
  - **puntualità** solo sul campione che l'AVM ha visto partire dal
    capolinea, sempre accanto alla sua copertura: in orario fra 1 minuto di
    anticipo e 5 di ritardo;
  - **niente penali**.
- **Le consorziate** stanno nel report dell'azienda, con la ripartizione per
  vettore.

**Dove.** In Esercizio › Consuntivo, nel riquadro del mese (quando ha almeno
una giornata chiusa):
- «Calcola il report» mostra indicatori, vettori e le linee con la regolarità
  km più bassa;
- «Scarica XLSX» e «Dettaglio corse (CSV)».

Li vede chi ha l'area Consuntivo, anche in sola lettura.

**Cosa conta**:
- solo le **giornate chiuse**. Le aperte sono elencate a parte, e così i
  giorni senza giornata. Il report si calcola anche prima di chiudere il
  mese, ma finché il mese non è chiuso è provvisorio;
- le corse **aggiunte** si contano a parte e non entrano nella regolarità.

**Le ripartizioni**:
- linea, tipo di servizio e contratto: dalle linee di Planning Studio, dove
  impostati;
- comune: il ritaglio dei percorsi sui confini importati in Planning Studio ›
  Zonizzazione, con i km di ogni corsa divisi in proporzione al tratto dentro
  ogni comune. Due righe in più, «Fuori dai confini importati» e «Corse senza
  percorso», fanno tornare la somma con i km del mese. Senza confini
  importati la ripartizione per comune non c'è, e il report lo dice;
- causale, col codice dell'ente;
- giorno;
- vettore: dalla vettura (Conerobus o la consorziata). «Vettura non
  indicata» sono le corse confermate senza vettura (per esempio le
  presunte); «Vettura non attribuita» quelle con una matricola che non si
  riesce a ricondurre a un'azienda.

**Il CSV**: separatore `;`, virgola decimale, una riga per corsa, giorno per
giorno e in ordine di partenza. In un mese sono circa centomila righe: si scrive man
mano, senza tenerlo tutto in memoria.

**Nessuna migrazione.** Alla conferma, una corsa proposta per continuità
prende ora la vettura del turno macchina, così il report per vettore non la
lascia senza vettura. Vale per le conferme fatte da qui in poi.

**Dopo il deploy**:
1. Scrivi il **codice dell'ente** delle causali (Esercizio › Consuntivo,
   riquadro «Causali (amministratore)»), se non l'hai già fatto: esce nella
   ripartizione per causale.
2. La definizione di fatto: su un mese con giornate chiuse, i totali dell'XLSX
   tornano con la somma dei riepiloghi delle giornate, e le righe del CSV sono
   le corse di quelle giornate.

**Rollback**: immagine precedente. Il report non scrive niente.

### FleetCare e GTFS-Realtime (tappa 4.8)

Decisioni del 16/11/2026: le soppressioni del giornale vanno nel GTFS-Realtime;
FleetCare legge i km per vettura e per giorno del consuntivo.

**GTFS-Realtime** (`/api/gtfs-rt/trip-updates` e `/vehicle-positions`, stessi
indirizzi di prima). Cosa cambia:
- **Soppressioni.** Le corse che il giornale della giornata in corso dà per
  soppresse escono come `CANCELED`, con data e ora di partenza, e non portano
  anche un ritardo. Contano solo le soppressioni **confermate**: un
  annullamento dell'AVM resta un indizio finché qualcuno non lo conferma in
  Esercizio › Consuntivo.
- **Codici pubblicati.** Corse, linee e fermate escono con i codici del GTFS
  esportato da Planning Studio, quello che ricevono gli aggregatori. Prima
  uscivano gli id interni del feed in esercizio, che con un programma di
  Planning Studio non corrispondono a niente nel GTFS pubblicato. Per i feed
  caricati a mano resta l'id del feed, come nell'export.
- **Data della corsa** (`start_date`) quando la corsa è nella giornata di
  esercizio: distingue le corse a cavallo della mezzanotte.
- **Solo SIRI.** I ritardi vengono solo dai passaggi del connettore SIRI. Il
  sistema AVM scrive i propri nelle stesse tabelle con altri codici, che gli
  aggregatori non abbinano.
- **Errori.** Fuori va un messaggio generico; i dettagli restano nel log.

Fuori, per ora: le corse aggiunte (`ADDED`) e le fermate saltate delle
parziali. La specifica le gestisce male, e delle parziali non sappiamo quali
fermate sono state saltate.

**I km per vettura per FleetCare** (migrazione `0030`):

```sql
SELECT * FROM public.esercizio_km_per_vettura('2026-12-01', '2026-12-31');
```

Restituisce una riga per giorno e vettura (il codice dell'AVM, che FleetCare
abbina al suo parco):
- `km_servizio`: le corse fatte con quella vettura indicata;
- `km_dal_turno`: le corse senza vettura (per esempio le presunte) del turno
  macchina che quel giorno ha avuto una vettura sola;
- `km_vuoto`: i km a vuoto programmati dello stesso turno macchina.

Cosa sommare lo decide FleetCare. Un turno macchina con due vetture nello
stesso giorno non attribuisce né le corse senza vettura né i vuoti. Contano
solo le **giornate chiuse**, al più 367 giorni per chiamata.

La funzione legge con i diritti di chi la chiama. A ogni avvio il migratore dà
a `fleetcare_legge_cerbero` la lettura delle sole colonne che servono:
- giorno e stato delle giornate;
- vettura, km fatti, esito, turno macchina delle corse;
- i vuoti dei turni macchina.

Nessun dato delle persone: turno guida e conducente restano fuori.

**Dopo il deploy**:
1. `node lib/db/scripts/ruoli.mjs --verifica` deve tornare pulita: la lettura
   delle colonne a FleetCare la dà il migratore.
2. In una giornata con una soppressione confermata,
   `/api/gtfs-rt/trip-updates?format=json` deve mostrarla con
   `"scheduleRelationship": 3`, e i `tripId` devono essere i codici del GTFS
   pubblicato.
3. La definizione di fatto per FleetCare, su 20 mezzi e un mese chiuso: i km
   di Cerbero contro la differenza del contachilometri fra i buoni carburante,
   entro la tolleranza decisa (propongo ±5%). I km di Cerbero per vettura:

   ```sql
   SELECT vettura, sum(km_servizio) AS servizio, sum(km_dal_turno) AS dal_turno, sum(km_vuoto) AS vuoto
     FROM public.esercizio_km_per_vettura('2026-12-01', '2026-12-31')
    GROUP BY vettura ORDER BY vettura;
   ```

   La lettura dal lato di FleetCare (e il confronto coi buoni) va in una PR su
   fleetmanagement.

**Rollback**: immagine precedente. La funzione resta e non scrive niente; per
toglierla: `DROP FUNCTION public.esercizio_km_per_vettura(date, date);`.

### La giornata di esercizio nella pagina Oggi (tappa 4.9)

Nella home, per chi legge l'area Consuntivo, il riquadro **Consuntivo** mostra
la giornata in corso:
- corse programmate;
- quota di corse **viste dall'AVM**: la proposta dell'AVM, che si aggiorna
  durante il giorno. Finché la proposta non c'è, il riquadro lo dice invece
  di scrivere zero;
- soppresse confermate, in giallo se ce ne sono;
- corse da decidere, con quelle da verificare;
- lo stato della giornata.

Sotto, in giallo, quante giornate sono **da chiudere** (cominciate e ancora
aperte dopo tre giorni, la stessa regola della pagina del consuntivo) e da
quando. Il riquadro porta al Consuntivo e si aggiorna ogni due minuti.

I dati vengono da `GET /api/esercizio/oggi`, che manda solo conteggi: la
giornata intera ha circa 3.500 corse. Nessuna migrazione.

**Dopo il deploy**: la definizione di fatto è che, aprendo Oggi durante il
servizio, i numeri del riquadro tornano con quelli della pagina del consuntivo
della stessa giornata.

**Rollback**: immagine precedente.

### Le variazioni decise in anticipo (tappa 4.10)

Decisioni del 16/11/2026. Fino all'inizio della giornata (le 03:00) il
lavoratore la ricostruisce da capo, e il giornale si scrive solo da lì: quello
che si sa prima (lavori, un evento, uno sciopero proclamato) adesso ha il suo
posto.

In Esercizio › Consuntivo, riquadro **Variazioni decise in anticipo**, chi ha
la scrittura sul Consuntivo può scrivere due tipi di variazione:
- **Soppressione**:
  - indica le linee e/o i numeri di corsa, ed eventualmente una fascia
    oraria sulla partenza (alle esclusa), con causale e nota;
  - quando la giornata comincia, le corse ancora da decidere diventano
    «soppressa» nel giornale, a nome di chi ha scritto la variazione, con il
    suo numero;
  - da quel momento escono come `CANCELED` nel GTFS-Realtime;
  - una corsa già decisa da qualcuno non si tocca;
  - scritta per una giornata già cominciata, vale subito.
- **Sciopero**:
  - indica le fasce garantite (per esempio «6-9, 12-15») e, se non tutte, le
    linee;
  - le corse fuori fascia **non** si sopprimono in anticipo, perché non si sa
    chi aderirà;
  - la proposta dall'AVM le dà come «soppressione probabile (sciopero)»
    invece che «non rilevate»;
  - «Presumi effettuate» non le tocca. Il filtro «Soppressioni probabili»
    della giornata le raccoglie, e si decidono in blocco con l'esito e la
    causale SCIOPERO.

**Annullare.** Una variazione si annulla, con il nome di chi la annulla, fino
all'inizio della giornata. Dopo si corregge nel giornale come sempre. I token
di servizio leggono e basta.

**Dove si vede.**
- Nell'elenco ci sono lo stato (in attesa, applicata con quante corse,
  annullata), chi l'ha scritta e, se la giornata è già preparata, le corse
  previste.
- Nel giornale, l'evento che nasce da una variazione lo dice.
- Il lavoratore applica le variazioni a ogni giro (ogni 15 minuti), dopo il
  congelamento. Nel log: «giornate di esercizio: variazioni decise in
  anticipo».

**La migrazione `0031`**: la tabella `esercizio_variazioni`.

**Dopo il deploy**: la definizione di fatto.
1. Si scrive una soppressione per domani, su una linea e una fascia.
2. Al giro dopo le 03:00 le corse risultano «soppressa» nel giornale, a nome
   di chi l'ha scritta.
3. Durante la giornata `trip-updates?format=json` le mostra come `CANCELED`.

**Rollback**: immagine precedente. La tabella resta, e la versione di prima
non la legge: le variazioni in attesa non si applicano più. Le soppressioni
già applicate restano nel giornale come ogni altro esito.

### Assenze che liberano il turno e sostituti suggeriti (tappa 5.1)

Decisioni del 16/11/2026. Prima un'assenza registrata non liberava il turno:
il conducente in malattia restava sul turno, e il turno risultava coperto.

**L'assenza libera il turno.**
- Un'assenza del conducente assegnato rimette il turno «da coprire». Il
  riposo «R» no.
- L'assegnazione non si cancella: resta come titolare. Si calcola dalle voci
  del roster, senza scrivere niente, quindi se l'assenza si toglie e nessuno ha
  coperto il turno il titolare torna.
- Nel tabellone il turno del conducente assente appare barrato. In basso, fra
  i turni scoperti, compare con il bordo rosso tratteggiato e «assente: …».
- Nella home, «turni scoperti» conta anche quelli liberati.
- Il motivo dell'assenza lo vede solo chi ha il permesso Roster, come prima.

**Sostituti suggeriti.** Col tasto destro su un turno scoperto, il dettaglio
mostra chi può coprirlo, in quest'ordine: liberi, a disposizione (D1, D2), già
in servizio ma compatibili.
- Si propongono i conducenti dello stesso deposito del titolare (o del
  turno), attivi, in servizio quel giorno e non fittizi.
- Restano fuori, contati ma senza dire chi né perché, quelli con un'assenza
  quel giorno (riposo compreso) e quelli a cui il turno creerebbe un riposo
  troppo corto o una sovrapposizione. Le regole sono quelle di sempre.
- **È un suggerimento: decide una persona.** «Assegna» fa la stessa
  assegnazione di sempre, con tutti i controlli. Il sistema non sceglie e non
  assegna da solo, quindi non è una decisione automatizzata sulle persone. Se
  in futuro si volesse l'assegnazione automatica, servirebbero l'informativa
  ai lavoratori e le valutazioni del caso.

**La sostituzione si ricorda.**
- Riassegnare il turno mentre il titolare è assente lo registra
  sull'assegnazione: il titolare, chi ha deciso, quando, e il motivo
  «assenza», senza il codice.
- Resta registrata anche nello storico del conducente («turno-sostituzione»)
  e, quando è acceso, nel registro delle modifiche.
- Un secondo sostituto tiene lo stesso titolare. Una riassegnazione normale
  (titolare non assente) o il ritorno del titolare la chiudono.
- Nel tabellone, il turno del sostituto ha un bordo tratteggiato e dice chi
  sostituisce.

**La migrazione `0032`**: in `roster_assignments` le colonne `titolare_id` e
`sostituzione`.

**Dopo il deploy**: la definizione di fatto.
1. Si segna un'assenza a un conducente con un turno: il turno compare fra gli
   scoperti.
2. Il tasto destro sul turno propone sostituti senza violazioni.
3. «Assegna» lo copre, e il turno ricorda il titolare.

**Rollback**: immagine precedente. Le colonne restano e la versione di prima
le ignora. I turni dei conducenti assenti tornano a sembrare coperti.

### La vestizione per deposito (tappa 5.2)

Decisioni del 16/11/2026. In Personale › **Vestizione**, per chi legge il
Roster, c'è la pagina del capo deposito: un deposito alla volta, oggi o domani.
Chi ha dei depositi assegnati parte dal suo, e vede solo i conducenti dei
depositi che vede, come nel tabellone.

**Cosa mostra.**
- **I turni del deposito, in ordine di uscita**, con chi li fa.
  - In cima quelli da coprire: gli scoperti e quelli liberati da un'assenza
    (5.1), con il titolare assente.
  - Su ciascuno, «Sostituti» apre i sostituti suggeriti della 5.1, con
    «Assegna».
  - Per un sostituto c'è scritto chi sostituisce.
- **I conducenti del deposito** in cinque gruppi: in servizio, liberi, a
  disposizione, a riposo, assenti. Il motivo di un'assenza lo vede chi ha il
  permesso Roster; gli altri leggono «ASS». I conducenti fittizi non ci sono.
- **L'ordine di servizio da stampare**: turni, orari e conducenti, con le
  riserve a disposizione. È il foglio per la bacheca: dei turni da coprire dice
  solo «DA COPRIRE», **mai chi è assente né perché**.

**Il deposito di un turno** viene dalla sua residenza nei turni guida,
abbinata al catalogo dei depositi come per i colori del tabellone. Un turno
senza residenza riconosciuta si vede solo con «Tutti i depositi».

**Nessuna API nuova e nessuna migrazione.**
- La pagina legge il tabellone di oggi e domani: in più c'è solo il deposito di
  ogni turno.
- Assegna con la chiamata di sempre, quindi riposi, sovrapposizioni e depositi
  si controllano come nel tabellone.
- Se un'assegnazione chiede di forzare un avviso, la pagina rimanda al
  tabellone.

**Dopo il deploy**: la definizione di fatto.
1. Il capo deposito apre Vestizione e trova il suo deposito, con i turni di
   domani in ordine di uscita e quelli da coprire in cima.
2. Copre un turno con «Assegna».
3. Stampa l'ordine di servizio, che non nomina gli assenti.

**Rollback**: immagine precedente.

### Mezzi: fabbisogno e disponibilità per deposito (tappa 5.3)

Decisioni del 16/11/2026. Quanti mezzi servono e quanti ce ne sono, deposito
per deposito.
- **Fabbisogno**: dai turni macchina della giornata di esercizio (4.3), per
  deposito e tipo di mezzo. Ogni turno macchina vuole un mezzo. Senza la
  giornata preparata non si sa, e la pagina lo dice.
- **Disponibilità**: dall'officina (FleetCare, la stessa funzione della pagina
  AVM).
  - Contano i mezzi in servizio e di riserva.
  - Quelli fermi in officina si elencano a parte, con «fermo dal» e commessa.
  - I dismessi non contano.
  - È lo stato **di adesso**: per domani si assume che chi è in officina oggi
    lo sia ancora, e la pagina lo scrive.
- **Confronto** sui totali per deposito: fabbisogno, disponibili, margine. Se
  mancano mezzi, in rosso. Per tipo di mezzo solo dove i turni e FleetCare
  usano lo stesso nome (per esempio «12m»). I depositi si abbinano al catalogo
  come i colori del tabellone.
- **Senza FleetCare** (funzione assente o non chiamabile) resta il
  fabbisogno, col motivo.

**Dove**:
- un riquadro «Mezzi» nella Vestizione, per il deposito e il giorno scelti;
- un riquadro «Mezzi» nella home, con i depositi in cui mancano, per chi legge
  il Roster.

L'API è in sola lettura: `GET /api/roster/mezzi?giorno=`. Chi vede solo
alcuni depositi vede solo quelli.

**Nessuna migrazione.** Fuori, per dopo:
- le matricole vere assegnate ai turni macchina del giorno (fatto nella 5.4,
  qui sotto);
- la disponibilità futura, cioè i fermi programmati, che richiede una funzione
  nuova su FleetCare.

**Dopo il deploy**:
1. Nella home il riquadro «Mezzi» compare se FleetCare risponde e la giornata
   è preparata. Se manca, il motivo si legge in Vestizione.
2. La definizione di fatto: in un giorno feriale, per un deposito, i mezzi che
   servono tornano con i turni macchina pubblicati, e i disponibili con
   l'officina.

**Rollback**: immagine precedente.

### Le vetture sui turni macchina (tappa 5.4)

Il capo deposito assegna una vettura (la matricola dell'AVM) a ogni turno
macchina di oggi o di domani, dalla pagina Vestizione, nel riquadro «Vetture
sui turni macchina».
- **Le righe**: i turni macchina della giornata del deposito scelto, in
  ordine di uscita, con uscita e rientro, tipo di mezzo, corse e la vettura.
  Quelli senza vettura sono evidenziati.
- **La scelta**: i mezzi del deposito che FleetCare dà in servizio o di
  riserva, prima i liberi del tipo giusto; oppure la matricola scritta a mano
  (anche senza FleetCare).
- **Avvisi, mai blocchi**:
  - la stessa vettura su due turni macchina che si sovrappongono;
  - la vettura ferma in officina o dismessa;
  - il tipo del turno diverso dal modello della vettura, solo dove turni e
    FleetCare usano gli stessi nomi;
  - l'AVM che ha visto un'altra vettura sulle corse del turno.
- **Tabella a parte** (`esercizio_vetture`, migrazione `0033`): i turni
  macchina della giornata si riscrivono finché la giornata non comincia. Se un
  turno macchina sparisce con una nuova pubblicazione, la sua vettura resta
  «da riassegnare» e si toglie.
- **Nel consuntivo**: alla conferma (anche la presunzione), una corsa senza
  vettura vista dall'AVM né per continuità prende quella assegnata al suo
  turno macchina. Così i km per vettura (4.8) contano anche le corse che l'AVM
  non ha visto.

**Chi**: scrive chi ha il Roster in scrittura, sui depositi che modifica (il
capo deposito sui suoi); legge chi ha il Roster in lettura, sui depositi che
vede. Le assegnazioni senza turno (il deposito non si sa più) le vede e le
toglie solo chi non ha limiti. La giornata chiusa non si modifica più.

L'API: `GET /api/roster/vetture?giorno=`, `PUT /api/roster/vetture` (giorno,
vssId, turnoMacchina, vettura), `DELETE /api/roster/vetture?giorno=&vssId=&turnoMacchina=`.
Nel registro delle modifiche, coi valori; chi ha assegnato solo come nome.

**Dopo il deploy**:
1. La migrazione `0033` crea la tabella vuota: niente da fare a mano.
2. La definizione di fatto: in Vestizione, per un deposito e per domani, si
   assegna una vettura a ogni turno macchina; il giorno dopo, confermate le
   corse, quelle che l'AVM non ha visto portano la vettura assegnata.

**Rollback**: immagine precedente. La tabella resta e non dà fastidio.

### Il fornitore dell'AVM come dato dell'azienda (tappa 6.27)

Le pagine e i testi dell'AVM nominavano il fornitore del primo cliente:
- «Paline Mizar» nel menu e in Dati e integrazioni;
- «Codice Mizar» nella pagina delle paline;
- la colonna «Mizar» nel dettaglio di una corsa;
- «Richieste a Mizar» e «Incollalo nella mail a Mizar» nell'andamento;
- le spiegazioni del diario e della sonda SIRI;
- i fogli Excel.

Da questo rilascio il nome è un dato dell'azienda, in Amministrazione →
Azienda, scheda AVM, casella **Fornitore dell'AVM**. La migrazione `0052`
aggiunge `azienda.avm_fornitore` e per Conerobus mette «Mizar»: le pagine
restano come prima.

Senza nome:
- i testi dicono «al fornitore dell'AVM», «del fornitore dell'AVM»;
- le etichette corte dicono «AVM» («Paline AVM», «Codice AVM»).

Dove il testo parla del sistema centrale («anagrafica del centro Mizar») ora
dice «centro AVM» per tutti. Il destinatario «Mizar» del diario diventa il
valore interno «AVM» e la pagina lo mostra col nome del fornitore.
L'etichetta sulla mappa della previsione del fornitore è la sua iniziale
(«M» per Mizar).

Due residui di «FlashNet» nel diario diventano «codice dell'officina». Un
test dell'API e uno della web falliscono se un nome di fornitore torna nei
testi.

**Dopo il deploy**: niente da fare. Nessuna variabile e nessuna Watch Path
nuova (`vetture-azienda.ts` e `azienda.ts` sono già fra quelle del
lavoratore).

### Il sistema di bigliettazione regionale come dato dell'azienda (tappa 6.28)

Le pagine delle tariffe nominavano il sistema di bigliettazione della regione
del primo cliente:
- nella scheda Cluster, il metodo «… (Urban + Addensamenti)» e la «conformità
  …» nella sua spiegazione;
- l'export PDF delle polimetriche per cluster (copertina e intestazione di
  ogni pagina);
- la scheda già disattivata dell'assegnazione delle fermate ai nodi.

Da questo rilascio quelle etichette dicono **nodi tariffari regionali**, e il
nome del sistema è un dato dell'azienda: Amministrazione → Azienda, scheda
Tariffe extraurbane, casella **Sistema di bigliettazione regionale**. Compare
accanto («conformità ai nodi tariffari del sistema regionale …»); vuoto, si
legge «sistema regionale». La migrazione `0053` aggiunge
`azienda.bigliettazione_sistema` e per Conerobus mette il nome di prima.

Cambiano anche due nomi interni: il campo `readyForTelemaco` del report
dell'assegnazione ai nodi (`GET /api/fares/node-assignment/report`) diventa
`readyForRegionalSystem` (lo leggeva solo la scheda disattivata), e i link
condivisi delle polimetriche per cluster si salvano col metodo
`clusters_nodi_regionali` (i link già creati restano come sono). Il test sui
nomi dei fornitori, dell'API e della web, fallisce se il nome torna nei testi.

**Le linee extraurbane delle polimetriche.** L'import della pagina
Polimetriche teneva le linee il cui codice comincia con una lettera: le urbane
con un nome di lettere (JE1, BUS3, CIRCA, Y, C.D.…) finivano fra le
extraurbane. Ora urbana o extraurbana la dicono le reti dell'azienda, come per
l'ottimizzazione dei mezzi dalla 6.23. Vale per gli import nuovi; quelli già
fatti restano come sono: per toglierne le urbane, si rifà l'import dello
stesso GTFS.

**Resta da decidere** (non cambiato qui): la pagina Polimetriche divide i
percorsi in tratte fisse da 6 km e usa il numero di tratte come fascia, mentre
le fasce chilometriche dell'azienda (6.8) sono larghe 6 km fino a 42 km e poi
8 e 10. Oltre i 42 km le due non coincidono.

**Dopo il deploy**: niente da fare. Nessuna variabile e nessuna Watch Path
nuova (`azienda.ts` è già fra quelle del lavoratore; `fares-polimetriche.ts`
non ci entra).

### Le sezioni di censimento per ogni azienda, e la popolazione contata una volta (tappa 6.30)

**Lo script delle sezioni di censimento** (`scripts/src/import-census-sections.ts`)
leggeva solo il file delle Marche, con il percorso scritto nel codice, teneva
solo la provincia 42 e scartava le sezioni fuori da un riquadro attorno alle
Marche. Ora:
- il file della regione si passa come argomento: sono le basi territoriali
  2021 dell'ISTAT, uno per regione
  (`https://www.istat.it/storage/cartografia/basi_territoriali/2021/R<regione>_21.zip`,
  dentro `R<regione>_21_WGS84.shp` col suo `.dbf`);
- la provincia è quella di Amministrazione → Azienda (Provincia ISTAT), oppure
  una o più con `--province 042,041`;
- si scartano solo i centroidi fuori dall'Italia;
- la tabella si svuota e si riempie in una transazione sola, e solo se nel
  file ci sono sezioni della provincia: con il file sbagliato resta com'è.

Si lancia, con `DATABASE_URL`:

    pnpm --filter @workspace/scripts run import-census -- /percorso/R11_21_WGS84.shp [--province 042]

(il comando gira nella cartella `scripts`: meglio il percorso completo del file).

`test-shp.ts`, uno script di prova che contava le sezioni della provincia di
Ancona, non c'è più.

**La popolazione contata una volta.** In `census_sections` scrivono lo script
delle sezioni (codici di 12 cifre) e l'import della popolazione dei comuni
(pulsante «Popolazione dei comuni» in Sincronizzazione, `/cron/population`),
una riga per comune. Chi somma la popolazione somma tutte le righe: dopo lo
script, una pressione del pulsante faceva contare gli abitanti due volte
(circa 920.000 invece di 461.000 sulla rete di Conerobus). Ora, se ci sono le
sezioni, l'import dei comuni non aggiunge niente, toglie le righe dei comuni
rimaste e lo dice nel risultato. Senza sezioni fa come prima. Il testo della
scheda in Sincronizzazione dice cosa fa (prima parlava di «44 sezioni
censuarie»).

In produzione oggi ci sono solo le 5.545 sezioni (461.687 abitanti, caricate
il 26/03/2026): niente da correggere.

**Dopo il deploy**: niente da fare. Nessuna variabile e nessuna Watch Path
nuova.

### Il corrispettivo €/km di ogni rete (tappa 6.29)

Il calcolo dei turni macchina pesava i km a vuoto (uscite e rientri in
deposito, trasferimenti) al netto di un corrispettivo di **2,60 €/km scritto
nel codice**: quello dell'urbano di Ancona, usato per tutte le reti. Ma il
corrispettivo lo fissa la Regione rete per rete (per gli urbani comune per
comune), e non tutti i comuni lo pagano anche sui km a vuoto.

Da questo rilascio ogni rete, in Amministrazione → Azienda → «Reti e linee»,
ha:
- il **corrispettivo €/km**, al netto dell'IVA (vuoto: non indicato);
- la spunta **anche sui km a vuoto**.

Il calcolo dei turni macchina dà ai km a vuoto verso una corsa il corrispettivo
della rete di quella corsa, se la rete lo paga anche sui vuoti: lì i km sono
compensati e conta il tempo del conducente, come prima. Senza la spunta (o
senza corrispettivo) quei km costano per intero (da 0,40 a 1,00 €/km secondo
il mezzo, nelle regole dei turni macchina). Il valore generale nel codice è
ora 0: un'installazione nuova non dà per scontato nessun corrispettivo.

La migrazione `0054` aggiunge `reti.corrispettivo_km` e
`reti.corrispettivo_su_vuoti` e, per Conerobus, mette i valori dal 2026 della
DGR Marche 456/2026 (Allegato A), con la spunta su tutte le reti, come il
calcolo le contava finora:

| Rete | €/km |
|---|---|
| Urbano di Ancona | 2,60 |
| Urbano di Jesi | 1,76 |
| Urbano di Falconara | 1,92 |
| Urbano di Senigallia | 1,84 |
| Urbano di Castelfidardo | 1,68 |
| Urbano di Sassoferrato | 2,79 |
| Extraurbano | 1,66 |

Osimo (1,92 €/km nella stessa delibera) non ha ancora una rete: quando le sue
linee entrano nel GTFS, si crea la rete e si scrive lì.

**Per Conerobus i turni macchina non cambiano**: il costo di un km a vuoto
(al più 1,00 €/km) resta sotto ogni corrispettivo della delibera, quindi con
la spunta i km a vuoto restano compensati come con il 2,60 di prima. Cambiano
solo togliendo la spunta a una rete.

**Dopo il deploy**: in «Reti e linee» togliere la spunta alle reti i cui
comuni non pagano il corrispettivo sui km a vuoto. Nessuna variabile e nessuna
Watch Path nuova (`reti-linee.ts` è già fra quelle del lavoratore).

### Il tempo massimo del bus senza autista come regola dei turni guida (tappa 6.31)

A un cambio in linea il conducente che monta prende il bus entro un tempo
dall'arrivo di chi smonta: il bus non resta incustodito più di così. Il calcolo
dei turni guida usava **15 minuti scritti nel codice**; il calcolo dei turni
macchina aveva già la sua regola modificabile («Vettura sola al capolinea»).

Da questo rilascio è una regola dei turni guida: sezione «Copertura soste
(punti di cambio)», campo **Bus senza autista al cambio (max)**, da 0 a 60
minuti, 15 se non lo si tocca. Le regole salvate prima, che non lo hanno,
valgono 15. La leggono il calcolo (`crew_scheduler_v4.py`) e gli strumenti
delle correzioni a mano dei turni (`crew_tools.py`).

Sulla copia dei dati veri (scenario urbano del 5/12, 75 turni macchina):

| Regola | Turni guida | Cambi in linea | Attesa massima del bus | Cambi con attesa |
|---|---|---|---|---|
| 15 minuti (come prima) | 94 | 62 | 0 | 0 |
| 10 minuti | 94 | 62 | 10 | 6 |

Con 10 minuti, nelle soste fra 20 e 30 minuti chi monta prende il bus dopo 10
minuti invece di coprire tutta la sosta.

**Dopo il deploy**: niente da fare. Nessuna migrazione, variabile o Watch Path
nuova.

### Niente coordinate e riquadri del primo cliente nei calcoli (tappa 6.32)

Due resti trovati dopo l'inventario della 6.26.

**L'area dei punti d'interesse.** L'import da Google Places scartava i
risultati fuori da un riquadro scritto nel codice, e quello da OpenStreetMap
cercava dentro lo stesso riquadro: la provincia del primo cliente (43,20–43,95
N, 12,70–13,65 E). Ora il riquadro è quello che contiene i **cerchi di
ricerca** dell'azienda (Amministrazione › Azienda › Territorio, luoghi con uso
«punti d'interesse», ognuno col suo raggio), più 5 km di margine. Senza luoghi
anche l'import da OpenStreetMap si ferma con un messaggio, prima di cancellare
i punti d'interesse che ci sono (quello da Google lo faceva già).

Per Conerobus, coi 15 luoghi di oggi, il riquadro diventa 43,256–43,796 N,
12,764–13,700 E. Rispetto a prima:
- Google: la ricerca è già attorno ai cerchi, e il riquadro li contiene tutti
  con 5 km di margine: in pratica non cambia (si scarta solo un risultato che
  Google desse a più di 5 km fuori dai cerchi, a nord o a sud);
- OpenStreetMap: restano fuori la fascia a nord di 43,80 (nell'entroterra è la
  provincia di Pesaro e Urbino, per esempio Fano) e quella a sud di 43,256
  (provincia di Macerata), che non sono territorio servito. Per allargare
  l'area si aggiunge un luogo di ricerca, o se ne allarga il raggio.

Sulle copie locali non ci sono punti d'interesse salvati: quanti ne cambiano
si vede al prossimo import da OpenStreetMap in produzione.

**Una corsa senza coordinate.** Il calcolo dei turni macchina, se una corsa
gli arrivava senza le coordinate dei capolinea, la metteva in un punto del
primo cliente (43,6 N 13,5 E). Ora la mette al centro delle altre corse, come
fa già l'API per una fermata senza coordinate. L'API manda sempre le
coordinate: i turni macchina non cambiano (gli snapshot del calcolo sono
identici).

Un test dell'API e uno degli script Python falliscono se una coordinata
scritta a mano torna nel codice (nella web c'era già dalla 6.22).

**Dopo il deploy**: niente da fare. Nessuna migrazione, variabile o Watch Path
nuova (`geo-utils.ts` è già fra quelle del lavoratore).

**Rollback**: immagine precedente. La colonna resta e non dà fastidio.

### La codifica dei turni guida come dato dell'azienda (tappa 6.25)

Il solver dei turni guida dà a ogni turno un codice: la lettera del deposito
di residenza e tre cifre, da 001 per i turni del mattino e da 100 per quelli
del pomeriggio, divisi a mezzogiorno. Era la codifica del primo cliente,
scritta nel solver, con la lettera presa dall'iniziale del nome del deposito:
due depositi con la stessa iniziale si dividevano la lettera. Da questo
rilascio:
- **la sigla è del deposito**: nella pagina Depositi di Planning Studio si
  scrive da 1 a 3 lettere o cifre («A», «AN», «N2»). Vuota, vale l'iniziale
  del nome come prima. La migrazione `0051` aggiunge la colonna `depots.sigla`;
- **l'ora del pomeriggio è dell'azienda**: in Amministrazione → Azienda,
  scheda **Turni guida: i codici**. La migrazione aggiunge
  `azienda.turni_guida_pomeriggio_da` e per Conerobus mette le 12:00. Vuota,
  una sola numerazione da 001 in ordine di inizio;
- il solver riceve tutte e due in `config.codiciTurni`, dai turni guida della
  Fucina e dal VCSP. Senza, vale la regola di sempre.

Sulla copia dei dati veri la codifica nuova dà gli stessi codici della vecchia
su tutti i 7 scenari di turni guida salvati: 222 codici su 222.

**Dopo il deploy**: niente da fare. Una sigla si scrive solo se due depositi
cominciano con la stessa lettera, o se l'azienda ne usa una sua. Nessuna
variabile e nessuna Watch Path nuova (`azienda.ts` è già fra quelle del
lavoratore).

**Rollback**: immagine precedente. Le colonne restano e non danno fastidio.

### Il riferimento della regola regionale delle tariffe (tappa 6.24)

Le pagine delle tariffe misurano la distanza di un viaggio extraurbano sul
percorso con più corse della linea. Se più linee hanno gli stessi capolinea,
usano la media dei loro chilometri pesata sulle corse. La regola viene dalla
Regione, e le pagine ne scrivevano il riferimento nel codice («DGR 1036/2022
art. 2.d», che vale solo per le Marche), con le etichette «Regola 1» e
«Regola 2». Da questo rilascio:
- il riferimento è un dato dell'azienda: in Amministrazione → Azienda, scheda
  **Tariffe extraurbane: la regola regionale**. La migrazione `0050` aggiunge
  la colonna e per Conerobus mette «DGR Marche n. 1036/2022, art. 2.d». Le
  pagine lo mostrano accanto al calcolo; vuoto, non compare;
- le etichette dicono cosa fa il calcolo: «percorso con più corse della linea»,
  «più linee con gli stessi capolinea: media dei km pesata sulle corse»,
  «ricerca automatica fra le linee».

Il calcolo non cambia, e nemmeno le risposte dell'API (`ruleApplied` resta
`regola1`/`regola2`).

**Dopo il deploy**: niente da fare. Nessuna variabile e nessuna Watch Path
nuova.

**Rollback**: immagine precedente. La colonna resta e non dà fastidio.

### Urbano o extraurbano nei turni macchina, dalle reti dell'azienda (tappa 6.23)

L'ottimizzazione dei mezzi (Fucina: calcolo semplice, CP-SAT e VCSP; il
programma di esercizio) decideva se una linea è urbana o extraurbana dalla
prima lettera del nome: lettera → extraurbana. È la convenzione dei nomi del
primo cliente. Le urbane con un nome di lettere (Jesi JE…, Senigallia BUS…,
Castelfidardo CIRCA/CIRCB, Falconara Y, Ancona C.D. e C.S.) finivano fra le
extraurbane, e il solver le metteva sugli stessi mezzi delle extraurbane vere.
Da questo rilascio la categoria la dicono le **reti dell'azienda**
(Amministrazione → Azienda → Reti), come già per il Roster e le tariffe.

Le flotte restano separate, come oggi: un turno macchina è tutto urbano o
tutto extraurbano. La regola dell'esercizio è che un mezzo urbano fa solo
urbano, mentre un mezzo extraurbano o da noleggio fa anche le urbane. Lasciata
libera, però, il solver mette quasi tutto su mezzi extraurbani: sulla copia
dei dati veri 259 su 272, perché non sa quanti mezzi di ogni tipo ci sono.
Arriverà con i numeri del parco per tipo.

Sulla copia dei dati veri (5 dicembre, 3.502 corse, CP-SAT a 30 s, due giri
per regola):

| | regola della lettera | reti dell'azienda |
|---|---|---|
| linee classificate diversamente | — | 30 su 128 (452 corse) |
| mezzi | 283–286 | 295–297 |
| di cui fanno solo corse urbane (per le reti) | 76–77 | 107 |
| mezzi che mescolano urbane ed extraurbane | 136–137 | 0 |
| km a vuoto | 6.174–6.246 | 6.309–6.550 |

I mezzi in più sono quelli che prima mescolavano le due flotte, cosa che
l'esercizio non può fare con un mezzo urbano. I turni macchina di quelle linee
passano dal prefisso «E» al prefisso «U».

**Dopo il deploy**: niente da fare. Le reti dell'azienda sono già scritte
(tappa 6.7). Nessuna migrazione, variabile o Watch Path nuova (`reti-linee.ts`
è già fra quelle del lavoratore). Un'azienda senza regole delle reti ha tutte le
linee extraurbane, come nel Roster.

**Rollback**: immagine precedente.

### Le mappe partono dal centro dell'azienda (tappa 6.22)

Sedici mappe della web si aprivano su coordinate scritte nel codice: su Ancona
(tariffe, quattro mappe; coincidenze, intermodale, mappa degli orari, fuori
linea, mappa 3D della rete, scuole, pianificatore di viaggio), su Roma (editor e
cluster di Planning Studio, depositi, depositi della Fucina) o sull'Italia
(zone di Planning Studio). Da questo rilascio partono
tutte dal **centro delle mappe** scritto in Amministrazione → Azienda →
Territorio; quelle che si adattano ai dati lo fanno come prima, appena arrivano.
- Il pianificatore di viaggio cerca gli indirizzi prima a 80 km dal centro
  dell'azienda (prima: dentro un riquadro delle Marche), poi ovunque in Italia.
- Due calcoli davano per buona la latitudine delle Marche: la griglia delle
  fermate nell'analisi dei segmenti di domanda e il margine attorno al
  progetto nell'analisi intermodale. Ora contano i gradi alla latitudine delle
  fermate.
- Nell'ottimizzazione dei mezzi, una fermata senza coordinate prende il centro
  delle altre invece di un punto vicino ad Ancona.
- Un test della web fallisce se in una pagina tornano coordinate scritte a mano.

Per Conerobus non cambia niente: la latitudine media delle 3.901 fermate è
43,55° contro i 43,6° del codice (0,08% sui gradi di longitudine), nessuna
fermata è senza coordinate, e il centro dell'azienda è quello su cui si
aprivano già le altre mappe.

**Dopo il deploy**: niente da fare. Nessuna migrazione, nessuna variabile e
nessuna Watch Path nuova (`geo-utils.ts` è già fra quelle del lavoratore).

**Rollback**: immagine precedente.

### Il parco nel canale dell'AVM come dato dell'azienda (tappa 6.21)

Nel canale dell'AVM le vetture delle consorziate hanno una matricola di
cinque cifre: le prime due dicono l'azienda, le altre tre il progressivo del
codice del mezzo (11096 → CJ096). I prefissi, le eccezioni (le matricole che
non seguono la regola) e l'anagrafica dei mezzi con la descrizione (l'export
dell'officina, 365 righe) erano scritti nel codice
(`lib/parco-anagrafica.ts`). Da questo rilascio sono tre tabelle dell'azienda:
- la migrazione `0049` le crea e, per Conerobus, mette i valori che erano
  nel codice: 5 prefissi, 4 eccezioni, 365 mezzi;
- in Amministrazione → Azienda, riquadro **AVM: le consorziate e l'anagrafica
  dei mezzi**: prefissi ed eccezioni si scrivono e si salvano insieme;
  l'anagrafica si importa dall'export dell'officina (codice e descrizione
  separati da una tabulazione, o un CSV) e si scarica nello stesso formato;
- le pagine dell'AVM (diario, stato del parco, fogli per l'officina) e il
  report di esercizio li leggono come prima, insieme agli altri dati
  dell'azienda: un salvataggio vale subito nell'API e entro un minuto nel
  lavoratore;
- lo stato dell'installazione ha una voce in più.

Sulla copia dei dati veri il modulo nuovo risponde come quello di prima per
tutte le matricole del canale, da 1 a 15999 (16.003 casi: codice, azienda,
scheda e identità), e per tutti i 369 codici dell'anagrafica.

**Dopo il deploy**
1. La migrazione `0049` crea le tabelle e mette i dati: niente da fare a
   mano. Nessuna variabile e nessuna Watch Path nuova (`parco-anagrafica.ts`
   e `azienda.ts` sono già fra quelle del lavoratore).
2. Quando l'officina ha un export nuovo del parco, si importa dal riquadro.

**Rollback**: immagine precedente. Il codice di prima torna ai suoi valori;
le tabelle restano e non danno fastidio.

### La transcodifica trova le fermate dei feed di Planning Studio (tappa 6.20b)

La transcodifica delle paline punta al codice della fermata nel GTFS
dell'azienda («20045»). Un feed nato da Planning Studio però ha come
`stop_id` l'identificativo interno della fermata nel progetto, e il codice
sta nel suo «codice» stabile (tappa 3.1). Cerbero cercava il codice solo
fra gli `stop_id`: con un feed di Planning Studio in uso nessuna palina
trovava la sua fermata, e l'aggancio delle fermate dell'AVM ripiegava sul
numero e sul nome.

Da questo rilascio il codice della tabella porta alla fermata per `stop_id`
o, nei feed di Planning Studio, per codice stabile. Lo `stop_code` no: in un
GTFS dell'azienda può essere il numero dell'AVM. Vale per l'aggancio del
flusso SIRI, per le richieste di StopMonitoring, per la pagina Paline Mizar
(stati, collisioni, fermate senza codice), per i suggerimenti, la ricerca e
la deduzione dai dati. Una correzione si salva col codice della fermata, non
con l'identificativo interno, che cambia con la versione successiva del
programma.

Sulla copia dei dati veri, palina per palina (4.392 con una fermata nella
tabella), l'aggancio che farebbe il flusso SIRI col nome di Mizar:

| | Prima | Dopo |
|---|---|---|
| fermata giusta | 2.219 (per nome) | 3.892 (dalla tabella) |
| fermata sbagliata | 928 | 0 |
| nessuna fermata | 1.187 | 442 |
| la fermata della tabella non c'è nel feed | 58 | 58 |

Nella pagina: 3.892 paline abbinate (prima 0) e 500 «fermata assente», cioè
codici che il programma in esercizio non ha più. Si correggono dalla pagina
o con un import nuovo della tabella.

**Dopo il deploy**
1. Niente da fare a mano: nessuna migrazione, nessuna variabile, nessuna
   Watch Path nuova.
2. Entro dieci minuti l'indice del flusso SIRI si rilegge da solo.
3. In Paline Mizar il numero di paline «Abbinata» sale; le «Fermata
   assente» rimaste sono da guardare una per una.

**Rollback**: immagine precedente. L'aggancio torna a numero e nome.

### La transcodifica delle paline come dato dell'azienda (tappa 6.20)

La tabella che dice quale fermata del feed corrisponde a ogni codice palina
dell'AVM (4.400 righe di Conerobus, aprile 2026) era un file dentro il codice:
`artifacts/api-server/data/transcodifica-paline-mizar.csv`. Da questo
rilascio è la tabella `transcodifica_paline`, un dato dell'azienda:
- la migrazione `0048` la crea e, per Conerobus, la riempie con le righe del
  file, nello stesso ordine. Il file esce dal repository, e con lui la
  variabile `SIRI_STOP_ALIAS_FILE`;
- l'amministratore la sostituisce per intero da Dati e integrazioni →
  Paline Mizar → **Importa la transcodifica (CSV)**, con un file
  `mizar_ref,stop_id,nome`. Va bene anche quello scaricato da «Transcodifica
  corretta (CSV)». O entrano tutte le righe o nessuna: un codice palina che
  non va ferma l'import e dice la riga;
- le correzioni fatte a mano dalla stessa pagina restano dove sono e valgono
  sopra la tabella, anche dopo un import;
- lo stato dell'installazione (Amministrazione → Azienda) ha una voce in più.

Gli abbinamenti non cambiano: sulla copia dei dati veri sono identici prima
e dopo, palina per palina.

**Un difetto che c'era già, e che questa tappa non tocca.** Un feed nato da
Planning Studio mette nello `stop_id` l'identificativo interno della fermata
e il codice (`20045`) nello `stop_code`; la transcodifica punta al codice.
Così, con un feed di Planning Studio in uso, nessuna coppia trova la sua
fermata (sulla copia: 0 su 4.392, «fermata assente») e le fermate dell'AVM si
agganciano solo per codice o per nome. Si sistema nella tappa successiva.

**Dopo il deploy**
1. La migrazione `0048` crea la tabella e mette le righe: niente da fare a
   mano. Nessuna variabile nuova; se in Coolify c'era `SIRI_STOP_ALIAS_FILE`,
   si può togliere. Nessuna Watch Path nuova: il lavoratore non legge la
   transcodifica.
2. In Paline Mizar, in fondo alla pagina, la riga dice «Tabella dell'azienda,
   importata il …».

**Rollback**: immagine precedente. Il codice di prima torna al file, che è
nell'immagine di prima; la tabella resta e non dà fastidio.

### Il NeTEx con gli identificativi della Regione (tappa 6.19c)

La Regione Marche pubblica il NeTEx della rete ATMA con identificativi come
`epd:IT:ITI3:Line:ATMA_1/3`, `epd:IT:ITI3:ScheduledStopPoint:ATMA_1`,
`epd:IT:ITI3:Network:RETE_TPL_ATMA`. Cerbero scriveva `IT:ITI3:Line:1_3-…`,
cioè senza i due prefissi e con la «/» sostituita da un'impronta. Così la
stessa linea aveva due identificativi diversi, e chi riceve i due file non
li avrebbe riconosciuti come la stessa cosa.

Da questo rilascio:
- tre dati nuovi dell'azienda, in Amministrazione → Azienda → NeTEx per il
  NAP: il **prefisso degli identificativi** (`epd`), il **prefisso dei
  codici** (`ATMA`, che diventa `ATMA_` davanti al codice di linee, fermate e
  corse) e il **codice della rete** (`RETE_TPL_ATMA`). La pagina mostra come
  esce l'identificativo di una linea. Gli operatori restano col codice del
  gestore (`Operator:ATMA`);
- negli identificativi la «/» e il «.» restano, come nei file della Regione
  (`ATMA_1/3`, `ATMA_46/`, `ATMA_C.D.`): lo schema li ammette. I due punti
  «:» invece no, perché separano le parti dell'identificativo;
- l'operatore ha sempre il blocco dei contatti, anche vuoto. Senza, con un
  gestore che non ha né sito né telefono né email, il file non passava lo
  schema (non era il caso di ATMA, che li ha tutti e tre).

Sulla copia dei dati veri, delle 128 linee e delle 3.901 fermate di Cerbero,
109 linee e 3.853 fermate hanno lo stesso identificativo del file della
Regione del 9 luglio 2026. Le altre sono cambiate dopo luglio.

**Dopo il deploy**
1. La migrazione `0047` aggiunge le tre colonne e, per Conerobus, mette
   `epd`, `ATMA` e `RETE_TPL_ATMA`: niente da fare a mano. Nessuna variabile
   e nessuna Watch Path nuova: i file del NeTEx sono già fra quelle del
   lavoratore (`netex*.ts`, `azienda.ts`, `dati-aperti.ts`), purché il blocco
   in Coolify sia quello intero di questa guida.
2. Al primo giro il lavoratore rifà il NeTEx dei dati aperti con gli
   identificativi nuovi. Il GTFS non cambia e non si rifà.
3. Chi legge già il NeTEx dall'indirizzo stabile vede cambiare gli
   identificativi una volta. Da qui in poi restano quelli della Regione.

**Rollback**: immagine precedente. Il NeTEx torna con gli identificativi di
prima al primo giro; le tre colonne restano e non danno fastidio.

### Le risposte dell'API compresse (tappa 6.19b)

Dalla tappa 6.19a la mappa delle linee si vede anche per i feed nati da
Planning Studio, e con un feed vero la dashboard chiede 18 MB di JSON (tutte
le linee, a tratti). L'API non comprimeva niente. Da questo rilascio le
risposte di testo (JSON, CSV, XML, testo) sopra i 16 KB partono compresse,
se il browser lo accetta: brotli, altrimenti gzip. Quella mappa diventa di
0,9 MB.

- Mai le risposte di `/api/auth` (login, sessione, MFA): lì un segreto e un
  testo scelto da chi chiede starebbero nella stessa risposta compressa.
- Mai i file binari (ZIP, XLSX, PDF, GTFS-RT) né le risposte che arrivano a
  pezzi (la chat di Argos): non cambiano.
- Se davanti all'API c'è un proxy che comprime anche lui (Coolify può farlo),
  non comprime una seconda volta: vede la risposta già compressa e la lascia.

**Dopo il deploy**: niente da fare a mano. Nessuna migrazione, nessuna
variabile, nessuna Watch Path nuova. Per vedere che funziona, dal browser
(strumenti per sviluppatori → Rete) la richiesta
`gtfs/shapes/geojson` della dashboard ha `content-encoding: br`.

**Rollback**: immagine precedente. Le risposte tornano in chiaro.

### Una nuova azienda: che cosa scrivere e dove (tappa 6.18)

Dalla Fase 6 quello che era scritto nel codice per il primo cliente è un dato
dell'azienda. Un'installazione nuova parte vuota: queste sono le voci da
compilare, nell'ordine in cui conviene farlo. In cima ad Amministrazione →
Azienda il riquadro **«Che cosa c'è da compilare»** le conta dai dati, voce
per voce, e porta alla sezione dove si scrivono
(`GET /api/admin/installazione`, solo per l'amministratore).

**Servono** (senza, una parte dell'applicazione lavora male):

| Voce | Dove | Se manca |
|---|---|---|
| Nome, città, centro delle mappe | Azienda → Identità, Territorio | pagine e stampe senza nome, mappe sull'Italia e indirizzi del pianificatore cercati prima attorno al centro d'Italia, GTFS con l'agenzia «azienda» |
| Reti urbane e regole delle linee | Azienda → Reti e linee | tutte le linee extraurbane: tariffe urbane e riposi del Roster sbagliati (va bene solo per un servizio tutto extraurbano) |
| Depositi | Azienda → Depositi | Anagrafica e Roster senza depositi |
| Fasce chilometriche | Azienda → Fasce chilometriche | tariffe extraurbane senza prezzi |
| Catalogo dei titoli | Azienda → Catalogo dei titoli | un feed nuovo delle tariffe senza biglietti né abbonamenti |
| Categorie e supporti | Azienda → Tariffe: elenchi di partenza | un feed nuovo senza categorie di passeggero o senza supporti |
| Provincia ISTAT | Azienda → Territorio | l'import del pendolarismo si ferma |
| Comuni | Azienda → Comuni | l'import della popolazione non ha comuni; nell'analisi «Comune 042002» invece del nome |
| Dove cercare i punti d'interesse | Azienda → Luoghi di riferimento | la ricerca di scuole, ospedali e negozi si ferma |
| Punti di cambio | Planning Studio → editor della rete → Nodi di cambio | i turni guida non danno il cambio in linea |

**Facoltative** (senza, si lavora con meno dettaglio):

| Voce | Dove | Se manca |
|---|---|---|
| Gestori | Azienda → Gestori | nei GTFS e nel NeTEx l'agenzia è l'azienda |
| Punti del meteo | Azienda → Luoghi di riferimento | niente meteo |
| Poli di lavoro | Azienda → Luoghi di riferimento | l'analisi di uffici e zone industriali usa solo le mappe |
| Punti stradali del traffico | Azienda → Luoghi di riferimento | niente traffico rilevato, solo il modello |
| Centri urbani del traffico | Azienda → Luoghi di riferimento | il modello misura dal centro delle mappe |
| Nodi di scambio | Azienda → Nodi di scambio | l'analisi intermodale trova da sola solo le stazioni dai nomi delle fermate |
| Auto aziendali | Amministrazione → Parametri di esercizio | i turni guida contano 5 auto |
| Le vetture dell'azienda nell'AVM | Azienda → AVM | tutte le vetture del canale contano come dell'azienda |
| Codice locale NeTEx | Azienda → NeTEx per il NAP | il NeTEx non si esporta |
| Prefissi e codice della rete NeTEx (6.19c) | Azienda → NeTEx per il NAP | gli identificativi senza prefissi, diversi da quelli che pubblica la Regione |
| Fornitore dell'AVM (6.27) | Azienda → AVM | i testi dicono «il fornitore dell'AVM» e «Paline AVM» |
| Corrispettivo €/km di ogni rete (6.29) | Azienda → Reti e linee | il calcolo dei turni macchina conta i km a vuoto a costo pieno |
| Sistema di bigliettazione regionale (6.28) | Azienda → Tariffe extraurbane: la regola regionale | le pagine delle tariffe dicono «sistema regionale», senza il nome |
| Codici dei turni guida (6.25) | Azienda → Turni guida: i codici; la sigla in Planning Studio → Depositi | una sola numerazione da 001, e l'iniziale del nome del deposito |
| Riferimento della regola regionale delle tariffe (6.24) | Azienda → Tariffe extraurbane: la regola regionale | il calcolo dei km si vede senza la norma da cui viene |
| Consorziate e anagrafica dei mezzi nell'AVM (6.21) | Azienda → AVM: le consorziate e l'anagrafica dei mezzi | le matricole delle consorziate non si attribuiscono, e nessun mezzo ha la descrizione |
| Transcodifica delle paline dell'AVM (6.20) | Dati e integrazioni → Paline Mizar → Importa | le fermate dell'AVM si agganciano solo per codice o per nome |

Il riquadro segnala anche i **punti di cambio senza fermate**, che nessuno dei
due calcoli dei turni guida riconosce.

Nella stessa tappa:
- un test di guardia per gli script Python, come quelli della web e dell'API;
- le intestazioni e gli esempi nei commenti degli script senza il nome del
  primo cliente.

**Per Conerobus**: sulla copia dei dati veri tutte le voci sono compilate.
Resta un avviso: il punto di cambio «Tavernelle» non ha fermate (tappa 6.17).

**Dopo il deploy**: niente da fare a mano. Nessuna migrazione, nessuna
variabile, nessuna Watch Path nuova.

**Rollback**: immagine precedente. Il riquadro sparisce.

### I punti di cambio dei turni guida dai dati dell'azienda (tappa 6.17)

I punti dove un conducente dà il cambio a un altro in linea si scrivono nella
pagina dei punti di cambio, con le loro fermate. Le auto aziendali si
scrivono in Amministrazione → Parametri. Fino a questo rilascio però nel
codice c'erano anche sei punti di Ancona e cinque auto, e venivano usati in
tre casi:

- il **calcolo rapido** dei turni guida (il pulsante «greedy» della pagina dei
  turni guida) usava **sempre** i sei punti e le cinque auto del codice,
  qualunque cosa l'azienda avesse scritto;
- il **calcolo CP-SAT** usava i punti dell'azienda, ma senza punti scritti
  ripiegava sui sei di Ancona (nell'API e nel solver Python);
- le risposte dei calcoli già fatti, senza punti o auto salvati, mostravano i
  sei punti e le cinque auto.

Da questo rilascio:

- il calcolo rapido usa i punti dell'azienda e le auto scritte nelle
  impostazioni, come il CP-SAT;
- un punto si riconosce dal **nome intero** di una sua fermata, come nel
  CP-SAT. Prima il calcolo rapido cercava pezzi di nome («STAZIONE F»,
  «CAVOUR», «STAMIRA»…), e una fermata valeva come punto di cambio anche se
  l'azienda non l'aveva messa in nessun punto;
- **senza punti scritti non c'è nessun punto di cambio**, per tutti e due i
  calcoli;
- se manca il parametro delle auto aziendali vale 5, come già nella pagina
  dei parametri e nel CP-SAT.
- il risultato del CP-SAT dice le auto con cui ha davvero lavorato. Prima
  diceva sempre 5, anche quando il tetto era un altro: nella lettura del
  risultato si leggeva «5 auto aziendali disponibili» con 8 auto.

**Per Conerobus cambia il risultato del calcolo rapido.** Il CP-SAT no.
Misurato sulla copia con i dati veri, prima e dopo, sullo scenario
«Urbano 5/12»:

| | prima | dopo |
|---|---:|---:|
| punti di cambio | 6 del codice | 4 dell'azienda |
| auto aziendali | 5 | 8 |
| corse coperte (nessuna doppia) | 1.439 | 1.439 |
| ore di guida | 553,0 | 553,0 |
| turni (con i supplementi) | 223 | 183 |
| cambi in linea | 512 | 112 |
| ore di lavoro | 1.165,3 | 808,3 |
| ore di nastro | 1.244,2 | 935,8 |

Le corse e la guida sono le stesse. Cambia come il calcolo le spezza fra i
conducenti, perché ci sono meno fermate dove si può dare il cambio.

**Da guardare nella copia (e forse in produzione)**: il punto «Tavernelle»
dell'azienda non ha fermate, quindi non viene mai riconosciuto, né dal calcolo
rapido né dal CP-SAT. Per i cambi a Tavernelle vanno aggiunte le sue fermate
nella pagina dei punti di cambio.

**Dopo il deploy**
1. Niente da fare a mano: nessuna migrazione, nessuna variabile, nessuna Watch
   Path nuova.
2. Controllare che ogni punto di cambio abbia le sue fermate:
   `SELECT c.name, count(s.*) FROM stop_clusters c LEFT JOIN stop_cluster_stops s ON s.cluster_id = c.id GROUP BY c.name;`
   Un punto con zero fermate non serve a niente.

**Rollback**: immagine precedente. Il calcolo rapido torna ai sei punti e alle
cinque auto del codice.

### I nodi di scambio come dato dell'azienda (tappa 6.16)

Stazioni, porti, aeroporti e parcheggi scambiatori erano scritti nel codice in
**due copie che non coincidevano**:
- sei nodi per l'analisi intermodale, con le fermate GTFS;
- otto per le zone di coincidenza: senza l'aeroporto, con tre parcheggi
  scambiatori.

Da questo rilascio sono una tabella sola, dato dell'azienda, in
Amministrazione → Azienda → «Nodi di scambio».

- **Che cosa c'è di un nodo**: identificativo, nome, tipo (stazione, porto,
  aeroporto, parcheggio scambiatore), coordinate, fermate GTFS, minuti a piedi
  fino alla fermata, descrizione, e gli orari stimati di arrivi e partenze.
  - L'**identificativo** non cambia: è quello che le zone di coincidenza
    ricordano.
  - Gli **orari** si scrivono come testo, una riga per luogo:
    `Roma (FR): 06:10 07:35`. Si mettono in ordine da soli.
  - Al più 100 nodi.
- **Chi li usa**:
  - l'analisi intermodale: solo stazioni, porti e aeroporti, come prima. Per le
    stazioni l'orario vero scaricato da ViaggiaTreno vale sempre più della
    stima;
  - le zone di coincidenza: tutti, compresi i parcheggi;
  - l'ottimizzatore delle coincidenze e le zone senza orari loro: gli orari
    stimati del nodo;
  - il confronto fra programmi: «nodi intermodali serviti su N».
- **Togliere un nodo** non tocca le zone che lo ricordano: restano com'erano e
  perdono solo gli orari stimati, se non ne hanno di loro. L'elenco dice
  quante zone ricordano ogni nodo.
- **Un'installazione nuova parte senza nodi.** Le restano le stazioni che
  l'analisi trova da sola dai nomi delle fermate.

**Per Conerobus**: la migrazione `0046` mette i nove nodi delle due copie. Dove
differivano vale la versione dell'analisi. Misurato sulla copia con i dati
veri, prima e dopo:
- **identici, byte per byte**: l'analisi intermodale (elenco dei nodi e
  analisi, fuori e dentro un progetto), gli orari dei nove nodi, lo stato
  della sincronizzazione;
- **cambiano, come deciso**:
  - nelle zone di coincidenza c'è anche l'aeroporto (9 nodi invece di 8);
  - le descrizioni delle cinque stazioni e del porto sono quelle più lunghe;
  - due compagnie del porto hanno il nome intero («Patrasso (GR) -
    Minoan/Anek», «Durazzo (AL) - Adria Ferries»);
  - nel confronto fra programmi il totale dei nodi passa da 8 a 9; i nodi
    serviti restano gli stessi.
- Nella copia non ci sono zone di coincidenza; in produzione quelle già create
  restano com'erano. Una nuova creazione automatica delle zone crea anche
  quella dell'aeroporto.

**Visto nel browser**:
- in Azienda i nove nodi con tipo, posizione e corse stimate;
- modificate le partenze del porto: una riga scritta male viene rifiutata con
  il suo messaggio, una giusta si salva;
- aggiunto e tolto un nodo.

La pagina delle zone di coincidenza in locale non si apre (manca il token
delle mappe): l'ho controllata dall'API.

**Dopo il deploy**
1. La migrazione `0046` crea la tabella e mette i nove nodi: niente da fare a
   mano. Nessuna variabile e nessuna Watch Path nuova.
2. Gli orari stimati sono quelli che c'erano nel codice: conviene
   ricontrollarli, soprattutto porto e aeroporto, che non hanno un orario
   vero da scaricare.

**Rollback**: immagine precedente. Il codice di prima torna alle sue due
copie; la tabella resta e non dà fastidio.

### Il traffico come dato dell'azienda (tappa 6.15)

Tre cose del traffico erano scritte nel codice per la provincia di Ancona. Da
questo rilascio sono luoghi del territorio dell'azienda, in Amministrazione →
Azienda → «Luoghi di riferimento», dove stanno già i punti del meteo.

- **Punti stradali del traffico** (uso nuovo): i punti di cui il giro del
  traffico legge velocità e congestione ogni mezz'ora. Erano 37 nel codice.
  - Il **nome** di un punto è l'identificativo delle sue rilevazioni: è unico
    fra i punti. Cambiando nome a un punto, le sue rilevazioni lo seguono.
  - La **zona** è un attributo del punto, un nome libero: i punti con la
    stessa zona stanno insieme nella pagina Traffico. Scrivendola, la casella
    propone le zone che ci sono già. Un punto senza zona, e le rilevazioni di
    un punto tolto, stanno in «Senza zona» finché scadono (90 giorni).
  - Al più **100 punti**. Ogni punto è una richiesta a TomTom a ogni giro: la
    pagina dice quante richieste al giorno fanno i punti scritti (37 punti:
    1.776).
  - Senza punti il giro non chiede niente.
- **Centri urbani del modello del traffico** (uso nuovo): il traffico teorico
  cala con la distanza dal centro **più vicino** fra quelli scritti. Senza
  centri vale il centro delle mappe dell'azienda. Chi ha più città può
  scriverne più d'una.
- **Le zone non sono più rettangoli di coordinate**. Prima erano cinque,
  scritte due volte (nell'API e nella pagina) e con regole diverse fra loro.
  Ora la pagina mostra quello che dice l'API, e basta.
- **Per Conerobus non cambia niente**: la migrazione `0045` mette i 37 punti di
  prima, ognuno con la zona in cui lo metteva la regola di prima, e come
  centro urbano quello di prima (43,616 / 13,516). I colori delle zone nella
  pagina restano gli stessi: seguono l'ordine dei punti.
- **Le zone di prima erano grossolane**, e ora si correggono a mano. Per
  esempio il punto «Porto-Anc» è in «Zona Ovest» e «A14-Falconara» in
  «Entroterra», perché così li metteva il rettangolo. Dei 37 punti, 25 sono
  in «Entroterra», che era «tutto il resto».
- **Misurato**:
  - sulla copia con i dati veri, il modello sui punti delle linee: 1.012
    forme, 856.320 valori confrontati con quelli di prima, nessuno diverso;
  - i 37 punti e le zone nel database sono quelli di prima;
  - la copia non ha rilevazioni del traffico, quindi il traffico per zona è
    provato con rilevazioni di prova sui 37 punti: stesse zone, stessi numeri
    e stessa classifica della regola di prima (test sul database, anche in
    CI);
  - nel browser: i 37 punti con le zone e il centro in Azienda, una zona
    cambiata dalla pagina, un doppione rifiutato, e la pagina Traffico con le
    cinque zone e i colori di prima.
- **Trovato e non toccato**: la mappa delle linee con il traffico
  (`GET /api/gtfs/shapes/geojson`) non restituisce le linee di un feed nato da
  Planning Studio, perché ne legge le forme in un formato diverso da quello in
  cui vengono scritte. C'era già: è fuori da questa tappa.

**Dopo il deploy**
1. La migrazione `0045` aggiunge i due usi e la colonna della zona, e per
   Conerobus i 37 punti e il centro: niente da fare a mano. Nessuna variabile
   e nessuna Watch Path nuova.
2. In Amministrazione → Azienda → «Luoghi di riferimento» ci sono due sezioni
   in più: «Punti stradali del traffico · 37» e «Centri urbani del modello del
   traffico · 1».
3. Se in produzione ci sono rilevazioni di punti che non sono fra i 37 (non
   dovrebbero: l'elenco nel codice non è cambiato negli ultimi 90 giorni),
   compaiono in «Senza zona». Per controllare:
   `SELECT segment_id, count(*) FROM traffic_snapshots WHERE segment_id NOT IN (SELECT nome FROM territorio_luoghi WHERE uso = 'traffico') GROUP BY 1;`

**Rollback**: immagine precedente. Il codice di prima torna a usare i suoi 37
punti e i suoi rettangoli; i luoghi nuovi e la colonna della zona restano e
non danno fastidio. Le rilevazioni raccolte nel frattempo da punti aggiunti a
mano finiscono, col codice di prima, nella zona del loro rettangolo.

### I testi della web senza il nome del primo cliente (tappa 6.14)

Nelle pagine restavano una sessantina di righe che nominavano Ancona, ATMA,
le Marche o le altre città: etichette, aiuti, esempi, intestazioni delle
stampe. Da questo rilascio quello che si vede viene dai dati scritti in
Amministrazione → Azienda, o è un testo che vale per qualunque azienda.

- **Dai dati dell'azienda**
  - *Linee e fermate*: accanto ai conteggi c'è «rete» con città e regione
    («rete Ancona / Marche»); senza la città non c'è niente.
  - *Mappa del territorio*: accanto a «Stato Rete» c'è la città (prima c'era
    scritto «ATMA · Ancona»).
  - *Traffico*, nelle note: «nell'area di» più la città.
  - *Tariffe → Genera & Esporta*: le stampe delle polimetriche portano il nome
    dell'azienda. Prima era scritto nel codice; la pagina non lo passava mai.
  - *GTFS → Importa GTFS → Pianificazione & Costi*: le categorie con cui si
    classificano le linee sono le reti dell'azienda (Azienda → «Reti e
    linee»), più «Notturno» e «Altro». Prima erano sei scritte nel codice, con
    tre sole reti urbane. L'identificativo salvato è quello della rete
    (`urbano_ancona`; prima `urbano-ancona`, col trattino).
  - *Planning Studio → Zone*: il pulsante «Comuni prov. …» c'è solo se per la
    provincia dell'azienda (Azienda → «Provincia ISTAT») l'app ha il file dei
    confini. Oggi c'è quello della provincia 042. Per le altre resta «Carica
    un GeoJSON…».
- **Testi resi neutri**: gli aiuti di Tariffe, «Territorio e domanda»,
  «Sincronizza Dati», «Percorso e tariffa», e gli esempi nelle caselle
  (rotazioni dei riposi, zone di coincidenza, validità, depositi).
- **Tolto perché non era vero**: in *Linee e fermate* il riquadro «Fermata più
  servita: Piazza Cavour» era scritto a mano. Al suo posto c'è il numero delle
  linee del feed.
- **Sulle stampe delle polimetriche non c'è più «DGR Marche n. 1036/2022»**:
  c'è «fasce chilometriche regionali». Le fasce dalla 6.8 si modificano in
  Azienda → «Fasce chilometriche», e il numero della delibera nel codice
  sarebbe rimasto quello vecchio. Se sulle stampe serve la delibera, va
  aggiunta come dato dell'azienda: non è in questo rilascio.
- **Che cosa resta, e perché**: gli esempi nel modulo dell'azienda (sono esempi
  nelle caselle dove si scrivono proprio quei dati), il nome della provincia
  del file dei confini, e le zone della pagina Traffico con le loro
  coordinate. Queste ultime vanno in tabella insieme ai punti stradali, e con
  loro il centro da cui il modello del traffico misura la distanza
  (`ANCONA_CENTER` nell'API). **Il centro non è stato cambiato in questo
  rilascio**: quello delle mappe dell'azienda (43,58 / 13,45) è a circa 6 km
  dal centro di Ancona che il modello usa (43,616 / 13,516), e metterlo al suo
  posto avrebbe spostato le fasce del modello per Conerobus.
- **Un test fa la guardia** (`artifacts/transitintel/src/lib/nomi-di-luogo.test.ts`):
  legge i sorgenti della web senza i commenti e fallisce se compare un nome
  dell'azienda o dei suoi luoghi fuori dai posti elencati sopra. L'API ha
  ancora i nomi nei blocchi del traffico e dell'intermodale: la sua guardia
  arriva quando sono in tabella.
- **Verificato nel browser sulla copia con i dati veri**: Linee e fermate
  («rete Ancona / Marche», 128 linee), Zone («Comuni prov. Ancona» con i 47
  comuni), Traffico, Territorio, e la classificazione delle linee: il menu ha
  le sei reti urbane, Extraurbano, Notturno e Altro; quattro linee classificate
  e salvate hanno preso il tipo di tariffa giusto. **Non visti nel browser**:
  il riquadro «Stato Rete» (in locale manca il token delle mappe) e le stampe
  delle polimetriche (la copia non ha tariffe generate); li coprono il
  controllo dei tipi e un test sul codice.

**Dopo il deploy**
1. Niente da fare a mano: nessuna migrazione, nessuna variabile, nessuna Watch
   Path nuova.
2. Le linee classificate nell'analisi dei feed: nella copia dei dati veri la
   tabella è vuota. Per controllare in produzione:
   `SELECT category, count(*) FROM planning_route_classifications GROUP BY 1;`
   Se ci sono righe con il trattino (`urbano-ancona`), si allineano con:
   `UPDATE planning_route_classifications SET category = replace(category, '-', '_') WHERE category LIKE 'urbano-%';`
   Senza, quelle linee restano classificate e il loro tipo di tariffa vale
   ancora; ma nella pagina compaiono col loro identificativo, in grigio, e non
   entrano nel filtro per categoria.

**Rollback**: immagine precedente. Tornano i testi di prima; le linee
classificate con gli identificativi nuovi restano valide (l'API ricava il tipo
di tariffa dall'inizio dell'identificativo, che non cambia).

### I chilometri per gestore (tappa 6.13)

Per rendicontare ai consorziati servono i chilometri di ogni gestore. Da
questo rilascio i due report che contano i chilometri li ripartiscono anche
per gestore: il gestore è quello della linea, lo stesso dei GTFS (tappa 6.11).

- **Planning Studio → Elenco corse → «Stampa elenco»**: nel riepilogo dei km
  all'anno c'è la tabella «Km/anno per gestore», fra quella delle linee e
  quella del corrispettivo. Per ogni gestore: quante linee, i km per categoria
  di validità, il totale, la quota sul totale e, se è scritto il corrispettivo
  al chilometro, l'importo. I km a chiamata stanno in una colonna a parte e
  non entrano nel corrispettivo, come nella tabella dei ricavi. La somma dei
  gestori è il totale delle linee.
- **Esercizio → Consuntivo → «Report del mese»**: la tabella «Per gestore»
  nella pagina, il foglio «Per gestore» nell'XLSX (in fondo, dopo «Per
  vettore») e la colonna `gestore` nel CSV del dettaglio (l'ultima: le colonne
  di prima restano dove erano). Corse e km programmati, effettivi, persi e
  aggiunti, con la regolarità.
- **Quando compaiono**: nella stampa e nella pagina solo se i gestori con
  chilometri sono più d'uno; il foglio dell'XLSX se l'azienda ha almeno un
  gestore. Senza gestori non cambia niente.
- **Quale gestore, nel report del mese**: quello che la linea aveva nel
  programma in esercizio quel giorno, come già il tipo di servizio e il
  contratto. Assegnare oggi una linea a un altro gestore **non cambia i mesi
  già congelati**: vale dalle giornate che nascono dopo aver rimesso in
  esercizio il programma. È voluto: se una linea passa di mano a marzo, il
  report di gennaio deve dire ancora chi la gestiva a gennaio.
- **«Per vettore» resta**: è un'altra cosa. Il vettore viene dalla vettura
  che ha fatto la corsa (dall'AVM), il gestore dalla linea.
- **Una corsa senza linea** (per esempio una corsa aggiunta) e una linea che
  dice un gestore fuori elenco sono del predefinito.
- **Misurato sulla copia con i dati veri**, con due gestori di prova (102 e 26
  linee): nei km programmati 33.802,4 e 10.152,3 km, che sommati danno il
  totale (43.954,7); nel report del mese 2.637 e 865 corse, che sommate danno
  le 3.502 del totale, con gli stessi km.

**Dopo il deploy**
1. Niente da fare a mano: nessuna migrazione, nessuna variabile, nessuna Watch
   Path nuova.
2. Con un gestore solo (oggi ATMA) nella pagina e nella stampa non compare
   niente di nuovo; nell'XLSX del mese c'è il foglio «Per gestore» con una
   riga, uguale ai totali.
3. Per vedere la ripartizione nel report del mese: aggiungi i gestori, assegna
   le linee in Planning Studio e rimetti in esercizio il programma. Le
   giornate che nascono da lì in poi portano i gestori.

**Rollback**: immagine precedente. I report tornano senza la ripartizione.

### Il NeTEx con un operatore per gestore (tappa 6.12)

Con la 6.11 il GTFS ha un'agenzia per gestore; il NeTEx del profilo italiano
aveva ancora l'azienda come solo operatore, e i due file dei dati aperti non
dicevano la stessa cosa. Da questo rilascio gli operatori del NeTEx sono i
gestori.

- **Che cosa cambia nel file**: nel `ResourceFrame` c'è un `Operator` per ogni
  gestore che ha almeno una linea, nell'ordine dell'elenco, con nome, sito,
  telefono e posta. Ogni linea e ogni corsa portano il loro (`OperatorRef`).
  Una linea che dice un gestore fuori elenco, o niente, è del predefinito.
- **Che cosa non cambia**: chi trasmette il file (`ParticipantRef`), i
  contenitori e il nome della rete restano dell'azienda. Senza gestori il file
  esce uguale a prima, byte per byte.
- **Validazione**: il file con più operatori passa lo schema EPIP del profilo
  italiano; lo prova un test, obbligatorio in CI.
- **Dati aperti**: il NeTEx pubblicato si rifà se cambia l'elenco dei gestori
  (anche solo la posta di uno). Nella scheda dei dati aperti, quando sono più
  d'uno, compaiono «N agenzie» per il GTFS e «N operatori» per il NeTEx.
- **Conerobus**: l'elenco ha un gestore solo, ATMA. Misurato sulla copia con i
  dati veri: nel NeTEx **l'operatore passa da Conerobus S.p.A. ad Atma Scpa**
  sulle 128 linee e sulle 3.502 corse; nient'altro cambia, e il file resta
  valido. Con due gestori di prova (102 e 26 linee) il file ha due operatori
  ed è valido.

**Dopo il deploy**
1. Niente da fare a mano: nessuna migrazione, nessuna variabile, nessuna Watch
   Path nuova (i file dei gestori ci sono già dalla 6.11).
2. Al primo giro del lavoratore il NeTEx dei dati aperti si rifà con ATMA come
   operatore.

**Rollback**: immagine precedente. Il NeTEx torna con l'azienda come solo
operatore.

### I gestori: più agenzie nei GTFS, una per linea (tappa 6.11)

Chi programma il servizio può farlo per più aziende: un consorzio per i suoi
consorziati. Nei GTFS ogni azienda è un'agenzia (`agency.txt`) e ogni linea è
di una di loro (`routes.txt`). Fin qui l'agenzia era una sola. Da questo
rilascio c'è l'elenco dei gestori (tabella `gestori`, migrazione `0044`), e
ogni modifica resta nel registro.

- **Dove si scrivono**: Amministrazione → Azienda, scheda «Gestori», dopo
  «Reti e linee». Di ogni gestore: identificativo (quello del GTFS, non si
  cambia), nome, sito, e se si vuole telefono, posta e pagina delle tariffe.
- **Il predefinito**: il primo gestore che si aggiunge. È il gestore delle
  linee che non ne hanno uno loro. Si cambia col pulsante «Predefinito» su un
  altro gestore.
- **Dove si assegnano le linee**: Planning Studio → pagina della rete →
  «Gestori delle linee» (il pulsante c'è se l'azienda ha almeno un gestore).
  Si filtrano le linee per gestore o per nome, se ne scelgono quante si vuole
  e si assegnano insieme. Nel dettaglio di una linea c'è la tendina per
  cambiare il suo.
- **Che cosa c'è già sulle linee**: ogni linea porta l'identificativo
  dell'agenzia che aveva nel GTFS importato. Se quell'identificativo non è fra
  i gestori, la linea vale come «senza un gestore suo» e prende il
  predefinito.
- **Nei GTFS** (quello della pagina Tariffe e quello consegnabile di Planning
  Studio, dati aperti compresi): `agency.txt` elenca i gestori che hanno
  almeno una linea, nell'ordine dell'elenco, e in `routes.txt` ogni linea
  porta il suo. Chi pubblica (`feed_info.txt`) resta l'azienda nel
  consegnabile, e quello scritto in «Feed Info» nel GTFS delle tariffe.
- **Il feed delle tariffe** eredita i gestori dal programma quando il
  programma va in esercizio, come le linee.
- **Togliere un gestore** non tocca le sue linee: passano al predefinito, e
  tornano sue se lo si rimette. Il predefinito si toglie per ultimo.
- **Senza gestori** l'agenzia è l'azienda dell'installazione, per tutte le
  linee, come prima della 6.10.
- **I dati aperti**: se cambia l'elenco dei gestori il GTFS pubblicato si
  rifà. Con l'elenco vuoto non si rifà niente.
- **Conerobus**: la migrazione porta nell'elenco l'agenzia che c'era (ATMA)
  come primo gestore, predefinito, e tutte le linee dicono già «ATMA».
  Misurato sulla copia con i dati veri:
  - il GTFS della pagina Tariffe esce uguale a prima, in tutti i suoi file;
  - **il GTFS consegnabile di Planning Studio cambia subito**: l'agenzia
    passa da Conerobus S.p.A. (`conerobus`) ad Atma Scpa (`ATMA`) in
    `agency.txt` e nelle 128 linee di `routes.txt`. Gli altri file sono
    uguali, e chi pubblica (`feed_info.txt`) resta Conerobus. Vale anche per
    il GTFS dei dati aperti, che si rifà al primo giro del lavoratore.
- **La tabella `agenzia_gtfs`** della 6.10 resta, non più letta: serve a chi
  torna all'immagine precedente. Si potrà togliere più avanti.
- **Il NeTEx** con questa tappa aveva ancora l'azienda come solo operatore:
  dalla 6.12 (qui sopra) ha un operatore per gestore.

**Dopo il deploy**
1. Aggiungi alle **Watch Paths del lavoratore** in Coolify la riga nuova
   `artifacts/api-server/src/lib/gestori*.ts` (blocco «Watch Paths» più
   sopra), poi ridistribuisci il lavoratore.
2. In Amministrazione → Azienda la scheda «Gestori» dice «Un gestore: Atma
   Scpa (ATMA). Nei GTFS è l'agenzia di tutte le linee.»
3. Per passare ai consorziati: aggiungi i gestori, apri il programma in
   Planning Studio → rete → «Gestori delle linee», assegna le linee, poi togli
   ATMA se non deve più figurare.

**Rollback**: immagine precedente. Il codice di prima legge `agenzia_gtfs`,
che è rimasta com'era; la tabella `gestori` resta, senza effetti. I gestori
assegnati alle linee restano scritti sulle linee: il codice di prima li
ignora e scrive un'agenzia sola.

### Gli elenchi delle tariffe e l'agenzia dei GTFS (tappa 6.10)

Nella pagina Tariffe restavano nel codice quattro cose di una sola azienda: le
categorie di passeggero, i supporti, i nodi del tariffario e la riga di
`agency.txt`. Da questo rilascio sono dati dell'azienda (migrazione `0043`,
tabelle `categorie_catalogo`, `supporti_catalogo`, `nodi_catalogo` e
`agenzia_gtfs`), e ogni modifica resta nel registro.

- **Dove**: Amministrazione → Azienda, scheda «Tariffe: agenzia ed elenchi di
  partenza», dopo «Titoli di viaggio».
- **L'agenzia del GTFS**: con questa tappa era una sola, a parte dall'azienda
  (il consorzio). Con la tappa 6.11 (qui sopra) è diventata l'elenco dei
  gestori: la sua riga è il primo gestore.
- **Chi pubblica il feed** (`feed_info.txt`): resta quello scritto nel modulo
  «Feed Info» di ogni feed. In un feed che non lo ha ancora il modulo propone
  l'agenzia, invece di un nome scritto nel codice.
- **Categorie e supporti**: sono gli elenchi da cui la pagina Tariffe riempie
  un feed. Ognuno si salva tutto insieme. La categoria predefinita è una sola.
  Una categoria usata da un titolo del catalogo non si toglie. Cambiare un
  elenco non tocca i feed già riempiti: lì si ripreme il pulsante della pagina
  Tariffe, che riporta nomi e tipi a quelli dell'elenco.
- **Un difetto corretto**: nel GTFS i nomi con la virgola non erano fra
  virgolette. Due supporti di Conerobus («Tessera Regionale (€5,00 primo
  abb.)» e «Tessera Agevolati (€2,10 / anno)») davano in `fare_media.txt` una
  riga con un campo in più. Sul programma vero, dei dieci file del GTFS nove
  escono uguali a prima byte per byte e cambia solo questo, in quelle due
  righe.
- **I nodi tariffari**: la scheda dei nodi nella pagina Tariffe è spenta (il
  pulsante è commentato nel codice), quindi oggi l'elenco non lo usa nessuno
  dalla pagina. I quattordici nodi del 2013 sono comunque passati dal codice
  alla tabella, e la rotta che li copia in un feed legge da lì
  (`import-catalog` al posto di `import-atma-2013`). Non c'è una sezione per
  cambiarli: arriverà con la scheda, se si riaccende. In quella scheda è
  corretto anche l'elenco dei nodi di un feed, che restava sempre vuoto perché
  la pagina cercava i nodi in un campo che la risposta non ha.
- **I colori dei cluster urbani** sono quelli delle reti dell'azienda (prima
  cinque colori scritti nel codice, per cinque città): sulla mappa dei cluster
  una rete urbana ha lo stesso colore che ha nel resto della pagina.
- **Conerobus**: la migrazione carica le sette categorie, i sette supporti e i
  quattordici nodi che erano nel codice, e come agenzia ATMA, con la riga di
  `agency.txt` di prima. Un test confronta il file byte per byte.
- **Un'installazione nuova** parte con la sola categoria «ordinario», senza
  supporti né nodi, e come agenzia l'azienda.
- **Non cambia**: il GTFS consegnabile di Planning Studio, che scrive come
  agenzia l'azienda (tappa 3.4).

**Dopo il deploy**
1. In Amministrazione → Azienda la scheda nuova dice «Nel GTFS delle tariffe
   l'agenzia è Atma Scpa (ATMA), non l'azienda», con 7 categorie e 7 supporti.
2. Nessuna variabile nuova e nessuna Watch Path da aggiungere.

**Rollback**: immagine precedente. Le tabelle restano, senza effetti: il
codice di prima ha i suoi elenchi scritti dentro.

### Il catalogo dei titoli di viaggio (tappa 6.9)

I biglietti e gli abbonamenti con cui si riempie un feed erano tre elenchi nel
codice, con i nomi e i prezzi di una sola azienda. Da questo rilascio sono un
catalogo dell'azienda (tabella `titoli_catalogo`, migrazione `0042`), e ogni
modifica resta nel registro.

- **Dove**: Amministrazione → Azienda, scheda «Titoli di viaggio», raggruppati
  per rete. Di un titolo si cambia tutto tranne l'identificativo, che è quello
  del GTFS.
- **Che cosa c'è dentro**: biglietti di corsa semplice e di andata e ritorno,
  abbonamenti settimanali, mensili e annuali. Un titolo extraurbano può avere
  un prezzo per fascia chilometrica: nel feed il suo nome prende la fascia e i
  suoi chilometri. I biglietti extraurbani di corsa semplice non stanno nel
  catalogo: sono uno per fascia, col prezzo della fascia.
- **Il biglietto di riferimento**: ogni rete urbana ne ha al più uno. Con
  quello si dà il prezzo di una corsa urbana (simulatore, viaggi).
- **Riempire un feed** (pagina Tariffe): si copiano dal catalogo i titoli che
  nel feed mancano. Quelli che ci sono già non si toccano.
- **Niente più doppioni**: prima i due pulsanti non controllavano se un titolo
  c'era già, e ogni pressione raddoppiava tutti i titoli del feed (29
  diventavano 58). Ora no. I doppioni che ci sono già si tolgono da Tariffe →
  «Genera & Esporta» → «Togli i doppioni dei titoli»; la validazione del feed
  ha un controllo in più che li segnala.
- **Allineare un feed al catalogo**: Tariffe → «Prodotti & Supporti» →
  «Allinea al catalogo». Dice quali titoli del feed hanno nome, prezzo o durata
  diversi dal catalogo e dalle fasce chilometriche, e dopo la conferma li
  allinea. È il modo di portare in un feed un prezzo cambiato nel catalogo o
  nelle fasce.
- **Le regole delle reti urbane** ora vengono dai titoli che ci sono nel feed:
  una regola per ogni biglietto urbano che ha una durata, per tutte le reti
  urbane dell'azienda. Prima erano sei regole scritte a mano per Ancona, Jesi
  e Falconara, e quelle di Falconara puntavano a un identificativo
  (`falconara_60min`) che nei feed riempiti dall'elenco grande non c'era.
- **Conerobus**: la migrazione carica i 159 titoli che erano nel codice. Un
  test confronta quello che scrivono i pulsanti con quello che scrivevano
  prima, titolo per titolo. Tre differenze volute:
  - Falconara ha un identificativo solo (`falc_60min`, `falc_ar`), quello
    dell'elenco grande. I feed che hanno già `falconara_60min` lo tengono;
  - nove biglietti urbani hanno ora la durata (60 o 100 minuti) anche se
    arrivano dall'elenco grande, che prima li scriveva senza;
  - Senigallia, Castelfidardo e Sassoferrato hanno il loro biglietto di
    riferimento, e quindi la loro regola di tratta.
- **Un'installazione nuova** parte col catalogo vuoto: un feed si riempie dei
  soli biglietti per fascia, se le fasce ci sono.
- **Una rete coi titoli nel catalogo è in uso**: non si toglie finché non si
  spostano o si tolgono.
- **Fuori da qui**: le categorie dell'analisi di Planning Studio. Le categorie
  di passeggero e i supporti di partenza sono diventati elenchi dell'azienda
  con la tappa 6.10 (qui sopra).

**Dopo il deploy**
1. In Amministrazione → Azienda la scheda «Titoli di viaggio» mostra 159
   titoli: 20 biglietti e 139 abbonamenti.
2. Nella pagina Tariffe, «Genera & Esporta» → «Valida Feed»: se la riga
   «Titoli di viaggio senza doppioni» è rossa, premi «Togli i doppioni dei
   titoli».
3. Poi «Genera Anteprima Tariffe», per rigenerare le regole delle reti urbane.
4. Nessuna variabile nuova e nessuna Watch Path da aggiungere.

**Rollback**: immagine precedente. La tabella resta, senza effetti: il codice
di prima ha i suoi elenchi scritti dentro.

### Le fasce chilometriche dell'extraurbano (tappa 6.8)

Il prezzo di una corsa extraurbana viene dalla distanza: a ogni fascia di
chilometri il suo prezzo. La tabella delle fasce era scritta due volte nel
codice (tariffe a zone e tariffe minime), uguale, con i prezzi di una sola
azienda. Da questo rilascio è un dato dell'azienda (tabella `fasce_km`,
migrazione `0041`), e ogni modifica resta nel registro.

- **Dove**: Amministrazione → Azienda, scheda «Fasce chilometriche».
- **Come si scrivono**: di ogni fascia si scrive dove finisce e quanto costa;
  comincia dove finisce quella prima (la prima da 0 km), quindi buchi e
  sovrapposizioni non si possono scrivere. Una distanza sta in una fascia se
  è più di «da» e al più «a»; oltre l'ultima fascia vale l'ultima. Si salvano
  tutte insieme.
- **Avviso, non divieto**: se una fascia più lunga costa meno di quella
  prima la scheda lo dice, ma lascia salvare.
- **Conerobus**: la migrazione carica le 23 fasce che erano nel codice (da
  0–6 km a 1,35 € fino a 190–200 km a 8,75 €). I prezzi calcolati non
  cambiano: un test confronta la fascia di ogni decimo di chilometro da −5 a
  260 con quella di prima.
- **Un'installazione nuova** parte senza fasce. Una rotta delle tariffe che
  ne ha bisogno risponde 409 e dice dove scriverle; niente prezzi inventati.
  Un'azienda che fa solo servizio urbano non ne ha bisogno.
- **Che cosa cambia quando cambi un prezzo**: i prezzi calcolati da lì in
  avanti (simulatore, viaggi, zone e tariffe minime generate dopo). I titoli
  di viaggio già creati in un feed tengono il loro prezzo, che si cambia
  dalla pagina Tariffe; le zone già generate restano come sono finché non si
  rigenerano.
- **Quando entra in vigore**: subito sull'istanza che ha salvato, entro un
  minuto sulle altre. Le fasce le usano solo le rotte delle tariffe: il
  lavoratore non le legge, e non ci sono Watch Paths da aggiungere.
- **Nel codice**: `lib/fasce-km.ts` (le regole e le fasce in vigore) e
  `lib/fasce-km-store.ts` (il database). Le rotte delle tariffe rispondono
  agli errori da un punto solo (`routes/fares-comuni.ts`).

**Dopo il deploy**
1. In Amministrazione → Azienda la scheda «Fasce chilometriche» mostra 23
   fasce fino a 200 km, da 1,35 € a 8,75 €.
2. Nessuna variabile nuova.

**Rollback**: immagine precedente. La tabella resta, senza effetti: il codice
di prima ha le sue fasce scritte dentro.

### Le reti dell'azienda e le regole delle linee (tappa 6.7)

Le reti (l'extraurbana e le urbane) e le regole che dal nome breve di una
linea ricavano la sua rete erano scritte nel codice, con i nomi di una sola
azienda. Da questo rilascio sono dati dell'azienda (tabelle `reti` e
`reti_regole`, migrazione `0040`), e ogni modifica resta nel registro.

- **Dove**: Amministrazione → Azienda, scheda «Reti e linee».
- **Le reti**: l'extraurbana c'è sempre ed è una sola; se ne cambiano nome,
  colore e ordine. Le urbane si aggiungono, si cambiano e si tolgono. Di una
  rete urbana nuova si scrivono il luogo e la sigla: l'identificativo
  (`urbano_<luogo>`), la zona tariffaria (`<luogo>_urban`) e il codice con cui
  si classificano le sue fermate li ricava il programma, e non cambiano più.
  Le reti urbane sono al più otto, perché i codici vanno da 2 a 9.
- **Una rete in uso non si toglie**: linee assegnate, titoli di viaggio, zone
  o regole tariffarie. Prima si sposta o si toglie chi la usa, dalla pagina
  Tariffe. Con la rete se ne vanno le sue regole delle linee.
- **Le regole**: un elenco in ordine, e vale la prima che corrisponde. I tipi
  sono cinque e basta: «comincia con», «è uguale a», «comincia con… più una
  cifra», «comincia con una cifra», «è di due lettere puntate». Una linea che
  non ne segue nessuna è extraurbana.
- **Anteprima**: prima di salvare le regole, dice quali linee del programma
  in esercizio cambierebbero rete e quali passerebbero da urbane a
  extraurbane o viceversa. Non scrive niente.
- **Che cosa seguono le regole**: la rete *proposta* per una linea nella
  pagina Tariffe (le linee già assegnate restano dove sono) e, nel Roster, se
  un'Unità di Progettazione è urbana o extraurbana quando nessuno l'ha scelto
  a mano: riposo minimo di 8 ore su linee urbane, di 9 su linee extraurbane.
- **Conerobus**: la migrazione carica le sei reti urbane, l'extraurbano e le
  otto regole che erano nel codice. Non cambia niente: sul programma in
  esercizio le 128 linee risultano nelle stesse reti di prima (64
  extraurbane, 36 di Ancona, 17 di Jesi, 8 di Senigallia, 2 di Castelfidardo,
  1 di Falconara).
- **Un'installazione nuova** parte con il solo extraurbano e nessuna regola:
  tutte le linee valgono come extraurbane finché l'amministratore non scrive
  le sue reti.
- **Nella web**: le etichette, le sigle e i colori delle reti arrivano con la
  sessione, come gli altri dati dell'azienda. Cinque punti della web avevano ognuno il
  suo elenco scritto a mano, e non coincidevano; ora leggono quello. Il
  simulatore prende gli stessi colori delle altre pagine.
- **Quando entra in vigore**: subito sull'istanza che ha salvato, entro un
  minuto sulle altre e sul lavoratore.
- **Fuori da qui**: i titoli di viaggio e i prezzi (ancora nel codice), e le
  categorie di partenza dell'analisi di Planning Studio.

**Dopo il deploy**
1. Aggiungi alle **Watch Paths del lavoratore** in Coolify le due righe nuove
   `artifacts/api-server/src/lib/reti-linee.ts` e
   `artifacts/api-server/src/lib/reti-lettura.ts` (blocco «Watch Paths» più
   sopra), poi ridistribuisci il lavoratore.
2. In Amministrazione → Azienda la scheda «Reti e linee» mostra sette reti e
   otto regole.
3. Nella pagina Tariffe i menu delle reti hanno le stesse voci di prima.

**Rollback**: immagine precedente. Le due tabelle restano, senza effetti: il
codice di prima ha le sue reti scritte dentro.

### Le reti delle linee e le zone urbane (tappa 6.6)

Due cose che il codice aveva in più copie, e un difetto che ne veniva.

- **La rete di una linea dal suo nome breve** (`JE…` è Jesi, `Y…` Falconara,
  `BUS5` Senigallia, `CIRCA` Castelfidardo, un numero è Ancona, il resto è
  extraurbano) era scritta tre volte: per le reti, per le tariffe minime e per
  i nodi. Ora è una sola, in `lib/reti-linee.ts`, con lo stesso comportamento.
- **L'elenco delle reti urbane** era ripetuto in più punti, e un controllo ne
  nominava tre su sei. Ora è una tabella sola, nello stesso file: per ogni
  rete il nome, la sigla, la zona tariffaria e i codici di classificazione
  delle fermate. Le reti di partenza, i codici e il controllo sulle priorità
  delle regole urbane si ricavano da lì.
- **Il difetto**: generando le zone, le fermate urbane di Senigallia,
  Castelfidardo e Sassoferrato finivano nella zona «Zona Urbana Falconara».
  Sul programma in esercizio (copia locale): la zona di Falconara aveva 328
  fermate, di cui 38 sue; le altre 290 erano di Senigallia (234) e di
  Castelfidardo (56), e le loro due zone restavano vuote. Ora ogni rete ha la
  sua zona (`lib/zone-urbane.ts`), e a ogni generazione le fermate finite in
  una zona urbana che non è la loro vengono tolte.
- **Chi le genera**: la sezione «Genera & Esporta» della pagina Tariffe, con
  qualunque metodo. Con «Proiezione Shape» e «Percorso Dominante» le zone
  urbane si creano e si riempiono. Con «Cluster Territoriali» le zone urbane
  non si creano (come prima), ma se ci sono già vengono rimesse a posto: prima
  quel metodo non le toccava.
- **Che cosa cambia nel GTFS**: solo `stop_areas.txt`, dove le fermate di
  Senigallia e Castelfidardo escono con la loro zona. I prezzi non cambiano:
  le regole urbane valgono per rete, non per zona.
- **Fuori da qui**: i titoli di viaggio e i prezzi, e gli elenchi delle reti
  nella web (colori ed etichette di quattro pagine). Restano per le prossime
  tappe.

**Dopo il deploy**
1. Le zone già generate restano come sono finché non le rigeneri: Tariffe →
   «Genera & Esporta» → «Genera Anteprima Tariffe», col metodo che usi di
   solito. L'avviso finale dice quante fermate ha tolto dalla zona sbagliata;
   la seconda volta non ne toglie più.
2. Nessuna migrazione e nessuna variabile nuova.

**Rollback**: immagine precedente. Le zone corrette restano corrette.

### Le vetture dell'azienda nell'AVM (tappa 6.5)

Nel canale dell'AVM passano anche le vetture delle aziende consorziate. Le
pagine dell'AVM (Diario, Controllo settimanale, Andamento) guardano di base
solo quelle dell'azienda, e solo quelle si confrontano con il parco
dell'officina. Per riconoscerle il codice aveva una regola scritta in tredici
punti, tre dei quali nella web e uno in una query: «matricola di 1-4 cifre =
vettura Conerobus». Da questo rilascio la regola è un dato dell'azienda.

- **Dove**: Amministrazione → Azienda, scheda «AVM: le vetture dell'azienda»,
  casella «Cifre della matricola» (colonna `azienda.avm_matricola_cifre`,
  migrazione `0039`). Una vettura è dell'azienda se la sua matricola nel canale
  è un numero con al più quelle cifre.
- **Casella vuota**: tutte le vetture del canale sono dell'azienda. Le pagine
  dell'AVM non mostrano più la scelta «solo …», perché non c'è niente da
  togliere.
- **Conerobus**: entra 4, quindi non cambia niente.
- **Un punto solo nel codice**: `lib/vetture-azienda.ts` nell'API,
  `eDellAzienda` in `lib/azienda.ts` nella web. Lo leggono l'identità di una
  vettura, il confronto col parco dell'officina, i filtri delle tre pagine, le
  esportazioni e la query dell'archivio del controllo settimanale.
- **Il nome dell'azienda nei testi**: «solo Conerobus» nelle pagine, «AVM
  Conerobus —» negli oggetti delle email al centro, il vettore nel report
  mensile e il suffisso dei file scaricati (`-conerobus.xlsx`) ora vengono dal
  nome scritto nella pagina Azienda. Per Conerobus sono gli stessi di prima.
- **Link già salvati**: `perimetro=conerobus` continua a valere; quello nuovo
  è `perimetro=azienda`.
- **Quando entra in vigore**: l'API e il lavoratore rileggono l'azienda ogni
  minuto. Dopo un salvataggio la regola vale subito sull'istanza che ha
  salvato, entro un minuto sulle altre.
- **Fuori da qui**: la tabella dei prefissi delle consorziate e l'anagrafica
  del parco scritta a mano (`lib/parco-anagrafica.ts`) restano del consorzio.

**Dopo il deploy**
1. Aggiungi alle **Watch Paths del lavoratore** in Coolify la riga nuova
   `artifacts/api-server/src/lib/vetture-azienda.ts` (blocco «Watch Paths» più
   sopra), poi ridistribuisci il lavoratore.
2. In Amministrazione → Azienda la casella «Cifre della matricola» mostra 4.
3. Nella pagina AVM le tre viste mostrano «solo Conerobus» come prima, con gli
   stessi numeri.

**Rollback**: immagine precedente. La colonna resta, senza effetti.

### I depositi dell'azienda (tappa 6.4)

I sette depositi di Conerobus erano scritti nel codice, e l'API li inseriva
**a ogni avvio** se mancavano: una seconda azienda se li sarebbe trovati senza
averli chiesti, e non c'era modo di crearne o toglierne uno. Da questo
rilascio i depositi sono dati dell'azienda.

- **Dove**: Amministrazione → Azienda, scheda «Depositi». Solo
  l'amministratore. Ogni modifica resta nel registro delle modifiche, coi
  valori (`roster_depositi` è fra le tabelle sorvegliate: ora sono 37).
- **Che cosa si scrive**: il nome, il gruppo (fermo o in servizio la domenica
  e nei festivi), i periodi dei turni (due al mese o ogni settimana), gli
  altri nomi con cui il deposito arriva da un file, l'ordine.
- **Il codice non cambia**: lo usano i gruppi turni e i depositi degli utenti.
  In un deposito nuovo si ricava dal nome («Jesi Urbano» → `jesi-urbano`), o
  si scrive a mano.
- **Un nome cambiato** resta fra gli altri nomi: i conducenti portano il
  deposito per nome, e così lo ritrovano. Chi ha lo storico prende subito il
  nome nuovo.
- **Le protezioni**:
  - un nome, un codice o un altro nome non può essere di due depositi;
  - un altro nome che qualche conducente usa non si toglie: resterebbe senza
    deposito;
  - un deposito in uso (conducenti, cambi di deposito programmati, gruppi
    turni, utenti) non si toglie: prima si sposta chi lo usa.
- **Conerobus**: non cambia niente, i sette depositi ci sono già. La
  migrazione `0038` li inserisce solo dove mancano e solo nell'installazione
  di Conerobus (la riga di azienda con `gtfs_agency_id` «conerobus»).
- **Un'installazione nuova** parte senza depositi: la scheda lo dice, e
  l'amministratore aggiunge i suoi. Senza depositi a un conducente non si può
  dare il deposito.
- **Le installazioni di prova** (`CERBERO_DATI_PROVA`): se non ci sono
  depositi, «conducenti di prova» crea anche sette depositi di esempio.
- L'API: `GET` e `POST /api/admin/depositi`, `PUT` e `DELETE
  /api/admin/depositi/:codice`.

**Dopo il deploy**: in Amministrazione → Azienda la scheda «Depositi» mostra i
sette depositi con chi li usa. Riavviando l'API non cambia niente.

**Rollback**: immagine precedente. I depositi restano com'erano; quelli tolti
di proposito tornerebbero al riavvio, come prima.

### Dati aperti a un indirizzo stabile (tappa 6.3)

Il NAP non riceve file a mano: scarica ogni giorno da un indirizzo che non
cambia. Da questo rilascio Cerbero pubblica il **GTFS consegnabile** (3.4) e il
**NeTEx del profilo italiano** (6.2) a due indirizzi fissi, senza login:

```
https://<dominio dell'API>/api/dati-aperti/gtfs.zip
https://<dominio dell'API>/api/dati-aperti/netex.xml.gz
https://<dominio dell'API>/api/dati-aperti          (che cosa c'è in linea, in JSON)
```

- **Nasce spento.** Lo accende l'amministratore in Amministrazione → Azienda,
  scheda «Dati aperti: gli indirizzi per il NAP», che mostra i due indirizzi
  da copiare. Da spento gli indirizzi rispondono 404. L'accensione e lo
  spegnimento restano nel registro delle modifiche (la colonna è
  `azienda.dati_aperti_attivi`).
- **Solo la versione in esercizio**, mai una bozza: la copia congelata (3.3)
  del feed acceso. Senza un programma in esercizio, o se quello in esercizio
  non ha una versione di Planning Studio (un file caricato a mano, o un
  programma in esercizio da prima della 3.3), i file si tolgono e la scheda
  dice perché: basta rimetterlo in esercizio da Planning Studio.
- **File già pronti.** Li prepara il **lavoratore**, che guarda ogni 10
  minuti, e li tiene nella tabella `dati_aperti` (migrazione `0037`). Chi
  scarica riceve i byte così come sono: sul programma vero di prova 4,1 MB di
  GTFS e 1,8 MB di NeTEx, in pochi centesimi di secondo.
- **Si rifanno solo quando serve**: quando cambia la versione in esercizio, o
  un dato dell'azienda che finisce nel file (ragione sociale, sito, telefono,
  identificativo GTFS, codici NeTEx). Altrimenti il giro fa due letture e
  basta. Sul programma vero la preparazione dura circa mezzo minuto.
- **Solo se validi.** Un GTFS con errori, un NeTEx che non passa lo schema, o
  che non si è potuto controllare (manca `xmllint`), non vanno in linea:
  **resta l'ultimo file buono**, e la scheda mostra il motivo accanto al file.
  Con gli stessi dati non si riprova (darebbe lo stesso esito); dopo un guasto
  si riprova da solo dopo un'ora. «Prepara adesso» rifà subito.
- **Scarico giornaliero leggero.** L'impronta SHA-256 del file è la sua
  `ETag`: chi lo ha già (`If-None-Match`, o `If-Modified-Since`) riceve 304
  senza che i byte si leggano. Lo stesso GTFS rifatto dà gli stessi byte.
- **Limite**: 30 richieste al minuto per indirizzo IP su questi tre percorsi.
- **Senza il lavoratore** (i calcoli dentro l'API, `CERBERO_LAVORATORE_INTERNO=1`)
  i file non si rifanno da soli: dopo una messa in esercizio va premuto
  «Prepara adesso».
- L'API dell'amministratore: `GET` e `PUT /api/admin/dati-aperti`
  (`{ "attivi": true }`), `POST /api/admin/dati-aperti/prepara`.

**Da sapere prima di registrare gli indirizzi al NAP**
- L'indirizzo comincia col dominio dell'API: se il dominio cambia, cambia
  l'indirizzo. Si registra quello definitivo.
- I codici NeTEx (`ITI3`, fornitore) vanno confermati con la Regione prima:
  cambiarli dopo cambia tutti gli identificativi del file.
- La licenza dei dati si dichiara nella registrazione al NAP: non è nel file.
- Un sito che scarica **dal browser** di un altro dominio è fermato dal CORS
  dell'API; il NAP e i validatori scaricano da un server, e passano.

**Dopo il deploy**
1. Aggiungi alle **Watch Paths del lavoratore** in Coolify le righe nuove del
   blocco «Watch Paths» più sopra (`dati-aperti.ts`, `gtfs-consegnabile.ts`,
   `gtfs-verifica.ts`, `netex*.ts`, `azienda.ts`, `assets/**`), poi
   ridistribuisci il lavoratore.
2. In Amministrazione → Azienda premi «Accendi la pubblicazione»: i file si
   preparano subito (mezzo minuto) e la scheda mostra «In linea» per tutti e
   due.
3. Apri i due indirizzi da un browser non collegato a Cerbero: si scaricano.
   Da riga di comando, la seconda richiesta con l'impronta dà 304:
   ```
   curl -sI https://<dominio>/api/dati-aperti/gtfs.zip | grep -i etag
   curl -s -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: "<impronta>"' https://<dominio>/api/dati-aperti/gtfs.zip
   ```
4. Alla prossima messa in esercizio, entro 10 minuti nel log del lavoratore
   compare «dati aperti: file pubblicati».

**Rollback**: «Spegni la pubblicazione» ferma subito gli indirizzi. Per il
codice, immagine precedente: la tabella e la colonna restano, ferme.

### NeTEx con il profilo italiano (tappa 6.2)

Il programma in NeTEx, **profilo italiano livello 1**, per il NAP. Il livello 1
coincide con il profilo europeo per l'informazione ai passeggeri, EPIP
(UNI CEN/TS 16614-4:2021). Riferimenti:
- le «Linee guida per la compilazione del profilo italiano del NeTEx»
  v4.0.1 (11 marzo 2024);
- lo schema EPIP pubblicato con il profilo italiano (repository GitHub
  `5Tsrl/netex-italian-profile`), copiato in `artifacts/api-server/assets/netex-epip/`.

- **Da dove**: lo stesso **GTFS consegnabile** della 3.4: la stessa versione
  (in esercizio, se c'è), la stessa azienda, gli stessi codici stabili, lo
  stesso controllo. Il NeTEx non ha una seconda lettura del programma.
- **Cosa c'è**, in un `CompositeFrame` `EU_PI_NETWORK_OFFER`:
  - l'operatore (`ResourceFrame`);
  - le fermate, una `StopPlace` con una `Quay` ciascuna (`SiteFrame`);
  - rete, linee, punti di fermata, assegnazioni e sequenze di fermate
    (`ServiceFrame`);
  - un tipo di giorno per servizio, con i suoi giorni (`ServiceCalendarFrame`);
  - le corse con gli orari, con il giorno dopo per quelle oltre la mezzanotte
    (`TimetableFrame`).
- **Identificativi**: `IT:[codice locale]:[Tipo]:[codice]`, più
  `:[fornitore]` se c'è (linee guida, 4.2.1). Il codice è quello stabile della
  3.1. Se contiene caratteri non ammessi (per esempio «/» o «:»), questi
  diventano «_» e in coda va un'impronta del codice originale: «46» e «46/»
  restano due linee diverse, e l'identificativo non cambia da un export
  all'altro.
- **Configurazione**, in Amministrazione → Azienda, scheda «NeTEx per il NAP»:
  - il **codice locale** (NUTS): per Conerobus entra «ITI3», cioè le Marche;
  - il **fornitore**, facoltativo: resta vuoto finché la Regione o ATMA non
    dicono quale.

  Senza codice locale l'export si ferma con il messaggio. **I codici vanno
  confermati con la Regione prima di consegnare il file.**
- **Controllo**: `xmllint` con lo schema EPIP, nell'immagine dell'API
  (`libxml2-utils` nel `Dockerfile.api`) e in CI, dove è obbligatorio.
  - Con errori nel GTFS di partenza o nello schema, l'export si ferma (422) e
    dice quali, a meno di «Esporta comunque».
  - Senza `xmllint` il controllo non si fa, e il server lo dice.
- **Dove**: in Planning Studio, il pulsante «Esporta NeTEx» accanto a quello
  del GTFS. Il file è `.xml.gz`. Sul programma vero di prova (3.502 corse,
  88.682 orari) pesa 39,8 MB, 1,8 MB compresso, e si fa in circa 30 secondi.
- L'API: `GET /api/planning-studio/projects/:id/export-netex?versione=&forza=1`
  per il file, `…/export-netex/verifica` per conteggi e controlli.

L'indirizzo pubblico e stabile che il NAP scarica ogni giorno è arrivato con la 6.3 (qui sopra).
Restano fuori anche i livelli successivi del profilo (2: contratti; 3: tariffe;
5: accessibilità).

**Dopo il deploy**:
1. Il redeploy ricostruisce l'immagine con `libxml2-utils`.
2. In Amministrazione → Azienda, scheda «NeTEx per il NAP»: il codice locale
   è «ITI3». Il fornitore va chiesto alla Regione.
3. La definizione di fatto: da Planning Studio si scarica il NeTEx del
   programma in esercizio, e il messaggio dice «Passa lo schema EPIP del
   profilo italiano».

**Rollback**: immagine precedente. Le due colonne restano; il codice di prima
non le legge.

### Il territorio dell'azienda (tappa 6.1)

Primo passo per installare Cerbero presso un secondo cliente. Il territorio di
Conerobus era scritto nel codice; ora sta in tabella (migrazione `0035`) e
l'amministratore lo cambia dalla pagina **Amministrazione → Azienda**, sotto i
dati dell'azienda.
- **Provincia ISTAT** (`azienda.provincia_istat`, tre cifre, per Conerobus
  «042»). La usano l'import della popolazione e quello del pendolarismo. Senza
  provincia l'import del pendolarismo si ferma col messaggio.
- **Comuni del territorio** (`territorio_comuni`): codice ISTAT a sei cifre,
  nome, soppresso. Ci sono anche centroide, superficie e popolazione di
  riferimento per l'import della popolazione. Prima i nomi stavano in **sei
  copie**:
  - quella dell'analisi della rete aveva i **nomi sfasati sui codici**
    (420260 «Monte Roberto», che è Montecarotto): ora i nomi sono giusti;
  - quella dell'import della popolazione aveva i **codici ISTAT scambiati**
    («042001» chiamato Ancona, che è Agugliano), e la popolazione letta
    dall'ISTAT finiva sul comune sbagliato. Ora si abbina per codice, e l'URL
    dell'ISTAT non chiede più i codici soppressi né salta i comuni 045-050.
  - Restano i tre comuni soppressi (Castel Colonna, Monterado, Ripe), che i
    dati del 2011 (sezioni, pendolarismo) nominano ancora.
- **Luoghi di riferimento** (`territorio_luoghi`), per uso:
  - dove si cercano i punti d'interesse (Google), col raggio. Senza luoghi la
    ricerca si ferma **prima** di cancellare i punti d'interesse che ci sono;
  - i punti del meteo;
  - i poli di lavoro e commercio dell'analisi della rete.
- **I valori di Conerobus** entrano solo nell'installazione di Conerobus (la
  riga di `azienda` con identificativo GTFS «conerobus»): 47 comuni più 3
  soppressi, 34 luoghi. Un'installazione nuova parte vuota.
- Nel registro delle modifiche, coi valori. Solo l'amministratore
  (`/api/admin/territorio`, mai un token di Argos).

**Cosa cambia per Conerobus**: i nomi dei comuni nell'analisi della rete
(prima sfasati) e la popolazione delle righe di comune che l'import settimanale
tiene in `census_sections` (prima presa dal comune sbagliato). Il resto è
uguale.

**Fuori, per dopo** (scritti ancora nel codice):
- la regola «matricola di 1-4 cifre = vettura dell'azienda» e le
  transcodifiche verso le consorziate: sono l'integrazione con il centro AVM
  di Conerobus, da rifare insieme per l'AVM di un altro cliente;
- il riquadro della ricerca OSM dei punti d'interesse e i punti stradali del
  traffico (cambiarli cambierebbe i dati raccolti): fatti nelle tappe 6.15
  (punti stradali) e 6.32 (riquadro);
- gli orari dei treni nei nodi intermodali (dovrebbero arrivare dal GTFS
  ferroviario) e il motore tariffario regionale.

**Dopo il deploy**:
1. In Amministrazione → Azienda la provincia è «042», sotto ci sono 47 comuni
   (più 3 soppressi) e 34 luoghi.
2. La definizione di fatto: nell'analisi della copertura della rete i comuni
   hanno il nome giusto; lunedì, dopo l'import della popolazione, le righe di
   comune hanno la popolazione del loro comune.

**Rollback**: immagine precedente. Le tabelle e la colonna restano; il codice
di prima non le legge.

### Il catalogo delle voci del roster (tappa 5.5)

Le voci di assenza e di presenza del roster (R, ASS, MA3, MA, I, PAD, STRA,
D1, D2, DISP, DAM1, DAM2) e le loro regole erano scritte nel codice. Ora stanno
nella tabella `roster_voci` (migrazione `0034`), e l'amministratore le cambia
dalla pagina **Amministrazione → Voci del roster**.
- **Le regole di ogni voce**:
  - **dato sanitario**: chi non ha il permesso la legge come «ASS – Assenza» e
    non la scrive (prima: MA3, MA, I, PAD);
  - **libera il turno**: il conducente manca e il suo turno torna da coprire
    (prima: tutte le assenze tranne R);
  - **a disposizione**: la presenza conta come «a disposizione» nella
    Vestizione e nei sostituti (prima: D1 e D2; DISP no, come prima);
  - **codice per le paghe** (BDROP): vuoto, per la tappa delle presenze;
  - **attiva**: una voce spenta non si offre più; quelle già scritte restano.
- **I 12 codici di prima** entrano con le regole di prima: il comportamento
  non cambia. Un codice che c'era già nelle voci o nelle rotazioni ma non nel
  catalogo entra **spento**, col codice come nome e con le regole di prima;
  l'amministratore gli dà un nome e decide se riaccenderlo.
- **Le protezioni**:
  - «dato sanitario» si accende e **non si spegne** dall'applicazione: le voci
    già scritte diventerebbero leggibili a chi non ha il permesso. Se serve
    davvero, si fa in psql come proprietario, con una decisione scritta;
  - **R e ASS** sono di sistema: cambiano solo nome, ordine e codice per le
    paghe (R è il riposo delle rotazioni, ASS è la voce che maschera i dati
    sanitari). Lo ripete un vincolo della tabella;
  - una voce usata (nel roster o in una rotazione) **non si cancella**: si
    spegne. Lo ripete una chiave esterna da `roster_entries`;
  - le rotazioni dei riposi accettano solo assenze attive e non sanitarie del
    catalogo (prima un codice qualsiasi, purché non sanitario).
- Nel registro delle modifiche, coi valori.

**Chi**: solo l'amministratore (`/api/admin/voci-roster`, mai un token di
Argos). Il roster legge le voci attive da `GET /api/roster/voci`, come prima;
il tabellone manda con ogni voce le sue regole.

**Dopo il deploy**:
1. Se la pagina mostra voci **spente col codice come nome** (in fondo
   all'elenco), erano codici già usati fuori dal catalogo: vanno guardate e
   battezzate (nome, regole), poi riaccese se servono. Per saperlo prima del
   deploy, in sola lettura:
   ```sql
   SELECT category, code, count(*) FROM roster_entries
    WHERE code NOT IN ('R','ASS','MA3','MA','I','PAD','STRA','D1','D2','DISP','DAM1','DAM2')
    GROUP BY 1, 2 ORDER BY 3 DESC;
   ```
2. La definizione di fatto: si aggiunge una voce nuova (per esempio un riposo
   compensativo che non libera il turno), la si scrive nel tabellone e il
   turno del conducente resta coperto.

**Rollback**: immagine precedente. Tabella e chiave esterna restano; il codice
di prima scrive solo i 12 codici, che ci sono.

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
  - dà a `cerbero_owner` USAGE su `public`, `caronte` e `coda`, e non CREATE:
    se lo aveva (serviva alle unità pigre, fino alla 2.16a) glielo toglie;
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
- **L'app non cambia la struttura del database** (PR 2.16b). Il migratore
  crea e tiene accesi sempre (`ENABLE ALWAYS`) tre event trigger di `postgres`
  (`cerbero_ddl_dell_app`, `…_fine`, `…_riscrive`). Come `cerbero_app` ogni
  comando che crea, altera o toglie un oggetto si ferma con «cerbero_app non
  può eseguire …»: tabelle (anche temporanee), colonne, indici, vincoli,
  funzioni, viste, trigger, permessi. Vale anche sulle tabelle che l'app
  possiede:
  - non può togliere una colonna, un vincolo o l'espressione di una colonna
    calcolata (`users.mfa_obbligatoria`), né spegnere i trigger del registro
    delle modifiche;
  - non può creare un oggetto che girerebbe come superutente quando lo
    incontra il migratore, un amministratore in psql o una funzione di
    FleetCare (la revisione della 2.8 lo aveva riprodotto);
  - non può creare una tabella temporanea: in una connessione del pool
    resterebbe davanti a quella vera per le richieste successive.

  I dati li legge e li scrive come prima. **Unica eccezione**: la manutenzione
  del registro delle modifiche, che il lavoratore chiama ogni giorno, crea la
  partizione del mese. È una funzione scritta dalle migrazioni e gira come
  `cerbero_registro`; lì dentro passano solo `CREATE TABLE` e `ALTER TABLE`.
- **Né espressioni pericolose.** Un'espressione di una tabella (default,
  vincolo CHECK, colonna generata, indice, tipo di una colonna) la esegue chi
  scrive la riga, una migrazione che cambia la colonna, il ripristino di un
  backup: a volte un superutente. Sono ammesse solo le funzioni dell'elenco
  (`FUNZIONI_AMMESSE` in `lib/db/scripts/ruoli-regole.mjs`), quelle di
  operatori e conversioni di sistema, e i tipi di sistema o delle estensioni
  (un dominio con un suo CHECK no). Quando l'app poteva ancora alterare le
  sue tabelle, la revisione aveva fatto girare SQL come superutente con un
  CHECK e `query_to_xml`. Il controllo a fine comando resta sui comandi della
  manutenzione del registro.
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
- **L'API non contiene DDL** (PR 2.16a e 2.16b). Le funzioni che creavano
  tabelle, colonne e indici al primo uso non ci sono più, e la duplicazione
  dei progetti non usa più tabelle temporanee: lo schema nasce solo dalle
  migrazioni, e un test guarda ogni sorgente dell'API.
  - **Ordine di rilascio.** La 2.16b va rilasciata dopo che la 2.16a gira su
    API **e** lavoratore. Il migratore applica il divieto prima che parta il
    container nuovo: un container vecchio ancora in esecuzione, con le unità
    pigre, riceverebbe «cerbero_app non può eseguire CREATE TABLE» sulle
    pagine che non aveva ancora aperto.
  - **Rollback.** L'immagine di prima: il suo migratore rimette la funzione
    dell'event trigger e il CREATE sugli schemi com'erano. Non c'è stato da
    disfare a mano.
  - **Se serve un intervento a mano sulla struttura** (un indice, una
    colonna): come `postgres`, con una migrazione. Come `cerbero_app` no, e
    nemmeno come `postgres` dopo `SET ROLE cerbero_owner`.
  - Aggiornare PostGIS non chiede più di togliere prima il CREATE su `public`
    a `cerbero_owner`: non lo ha.

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

Chi ha cambiato che cosa, scritto dal database: trigger su 31 tabelle (21
della prima ondata, 8 della seconda, i dati dell'azienda dalla 2.17a, i
diritti dei ruoli dalla 2.18) scrivono in `registro.modifiche`. L'app
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
   artifacts/api-server/src/lib/esercizio-*.ts
   artifacts/api-server/src/lib/service-day.ts
   artifacts/api-server/src/lib/km-programmati.ts
   artifacts/api-server/src/lib/siri-vm.ts
   artifacts/api-server/src/lib/parco-anagrafica.ts
   artifacts/api-server/src/lib/dati-aperti.ts
   artifacts/api-server/src/lib/gtfs-consegnabile.ts
   artifacts/api-server/src/lib/gtfs-verifica.ts
   artifacts/api-server/src/lib/netex*.ts
   artifacts/api-server/src/lib/azienda.ts
   artifacts/api-server/src/lib/vetture-azienda.ts
   artifacts/api-server/src/lib/reti-linee.ts
   artifacts/api-server/src/lib/reti-lettura.ts
   artifacts/api-server/src/lib/gestori*.ts
   artifacts/api-server/assets/**
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
    Dalla 2.16b l'app non può più toglierle l'espressione né toglierla (prima,
    da proprietaria di `users`, poteva). Il controllo resta per le altre
    strade: un ripristino, un comando a mano. Se succede:
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
   progetto di scheduling i cui turni guida sono pubblicati o assegnati, e un
   turni macchina così non si sovrascrive: salvandolo se ne crea una nuova
   versione (PR 3.6, «Turni macchina versionati e pubblicati coi turni guida»).
4. Pubblica chi ha il permesso Scheduling e vede il progetto di Planning
   Studio. Ogni pubblicazione e ogni ritiro restano nel registro della pagina.

### Menu e permessi

Il menu segue la giornata dell'azienda (`artifacts/transitintel/src/lib/navigazione.ts`):

| Sezione | Voci | Area che serve poter almeno leggere |
|---|---|---|
| Oggi | la pagina d'ingresso | tutti |
| Rete e orari | Planning Studio, Confronta programmi, Zone di coincidenza | Rete e orari |
| Turni | Progetti di esercizio, I miei calcoli | Turni |
| Pubblicazione | Turni al roster; Orari al pubblico (stampa orari, QR) | Pubblicazione dei turni; Pubblicazione degli orari |
| Personale | Roster, Anagrafica | Roster; Roster o Personale |
| Esercizio | Mappa live, AVM, Tempi osservati | Esercizio; i Tempi osservati anche con Analisi |
| Flotta | FleetCare | Flotta |
| Tariffe | Bigliettazione, Polimetriche, Simulatore, Prodotti e KPI, Percorso e tariffa | Tariffe |
| Analisi | Mappa del territorio, Traffico, Territorio e domanda, Linee e fermate GTFS, Ipotesi di linea | Analisi |
| Amministrazione | Utenti e accessi (admin), Ruoli (admin), Azienda (admin), Voci del roster (admin), Parametri di esercizio (admin), Registro delle modifiche (admin), Dati e integrazioni (Analisi o Esercizio), Sicurezza dell'account | — |

#### Ruoli aziendali (PR 2.14a)

Chi può cosa lo dicono i **ruoli aziendali**. Ogni ruolo dà, per ogni area del
menu, lettura o scrittura; una persona può averne più d'uno, e per ogni area
vale il diritto più alto. L'elenco dei ruoli e la matrice **di partenza** sono
nel codice (`lib/permessi/src/index.ts`, il pacchetto che leggono API e web).
Dalla PR 2.18 l'amministratore cambia che cosa dà ogni ruolo da
**Amministrazione › Ruoli** (qui sotto); per aggiungere un ruolo serve ancora
una modifica al codice.

La matrice di partenza:

| Ruolo | Rete e orari | Turni | Pubbl. orari | Pubbl. turni | Personale | Roster | Esercizio | Consuntivo | Flotta | Tariffe |
|---|---|---|---|---|---|---|---|---|---|---|
| Pianificatore | scrive | legge | scrive | legge | – | – | legge | legge | – | legge |
| Ufficio turni | legge | scrive | legge | scrive | – | legge | legge | legge | – | – |
| Capo deposito | legge | legge | legge | legge | – | scrive | legge | legge | legge | – |
| Centrale operativa | legge | legge | legge | legge | – | legge | scrive | scrive | legge | – |
| Officina | – | – | – | – | – | – | legge | – | scrive | – |
| Amministrazione | legge | legge | legge | legge | scrive | legge | legge | scrive | legge | scrive |

#### Cambiare che cosa dà un ruolo (PR 2.18)

**Amministrazione › Ruoli** (solo l'amministratore): una scheda per ruolo, e
per ognuna delle 11 aree tre scelte — niente, lettura, scrittura. Prima di
salvare la pagina elenca le modifiche, dice per quante persone valgono e
avvisa delle conseguenze.

- **Vale da subito**, anche per chi è già dentro: l'API ricalcola i diritti a
  ogni richiesta. Con più processi dell'API, gli altri lo vedono entro mezzo
  minuto.
- **Il giorno del rilascio non cambia niente**: la tabella nasce vuota, e
  vuota vuol dire matrice di partenza.
- **L'amministratore di sistema non dipende dalla matrice**: può sempre tutto,
  quindi cambiandola non ci si chiude fuori.
- **Che cosa c'è nel database**: `public.ruoli_diritti` (migrazione 0015) tiene
  solo le celle diverse dalla matrice di partenza (`N` niente, `L` lettura, `S`
  scrittura). «Riporta ai valori di partenza» toglie le righe del ruolo. Per
  vederle: `SELECT * FROM ruoli_diritti ORDER BY ruolo, area;`.
- **Che cosa succede a chi ha il ruolo**, nella stessa transazione del
  salvataggio:
  - la vista `users.permissions` si riallinea. La leggono FleetCare (senza la
    Flotta non si entra più) e la regola della verifica in due passaggi;
  - **dare Roster o Personale a un ruolo rende obbligatoria la verifica in due
    passaggi** per chi ce l'ha: chi non l'ha attivata dovrà farlo prima di
    continuare, anche se è già dentro. La risposta del salvataggio dice quanti
    sono;
  - **togliere il Roster spegne i dati sanitari** a chi non lo apre con un
    altro ruolo. Se poi il Roster torna, i dati sanitari non tornano da soli:
    si riaccendono utente per utente.
- **Dare il Personale a un ruolo** vuol dire far vedere a chi ce l'ha contatti,
  residenza, paghe, ferie e visite di tutti i dipendenti. È una scelta sul
  trattamento dei dati dei lavoratori: la pagina lo ricorda, ma a deciderla è
  chi ne risponde in azienda.
- **Ogni modifica finisce nel registro delle modifiche**, con i valori, e nel
  log dell'API («diritti di un ruolo cambiati»).
- **Se la matrice non si legge**, l'API non ripiega su quella di partenza
  (ridarebbe a un ruolo quello che gli è stato tolto): finché non l'ha letta
  almeno una volta le richieste falliscono, come per ogni altro guasto del
  database; dopo, vale l'ultima lettura.
- **Tornare indietro**: con l'immagine precedente vale di nuovo la matrice di
  partenza per tutti, cioè tornano i diritti tolti e spariscono quelli
  aggiunti. La tabella resta e nessuno la legge.

Fuori dai ruoli, date utente per utente in **Amministrazione › Utenti e accessi**:

- **Amministratore di sistema**: non è un ruolo di lavoro. Gestisce utenti,
  parametri e integrazioni, e può tutto.
- **Dati sanitari**: vede e scrive nel roster i codici di malattia, infortunio
  e 104. Chi non ce l'ha legge «assenza» senza il motivo. Vale solo per chi può
  aprire il roster; se perde il roster la capacità si spegne. Chi la deve avere
  è una decisione di chi è titolare dei dati.
- **Analisi**: nessun ruolo la dà.
- **Ruolo dentro FleetCare**: per chi ha la Flotta, che cosa può fare lì dentro.

Come funziona:

- **Lettura e scrittura.** Nell'API una richiesta `GET` chiede la lettura
  sull'area del suo percorso, ogni altra la scrittura. Fa eccezione un elenco
  corto di richieste che calcolano o leggono senza scrivere (verifica dei
  turni, simulazioni di tariffa, anteprima di una pubblicazione, domande ad
  Argos, validità e orari di molte corse insieme): `CALCOLANO_SENZA_SCRIVERE`
  in `artifacts/api-server/src/lib/permessi-rotte.ts`. Una lettura nuova fatta
  con una `POST` va aggiunta lì, altrimenti chi ha la sola lettura la vede
  rifiutare.
- **Sola lettura nelle pagine (PR 2.14b).** Chi può leggere un'area ma non
  scriverla vede in alto «Sola lettura». I comandi principali che modificano
  (lanciare un calcolo, salvare, pubblicare, mettere in esercizio, creare un
  progetto, gli strumenti del tabellone) restano visibili ma spenti, e passando
  sopra col mouse dicono quale scrittura serve; i cestini di riga non si
  mostrano. Dove un comando non è stato spento decide comunque l'API: risponde
  403 con `solaLettura: true`, e la web mostra un solo avviso «Sola lettura»,
  uguale in ogni pagina. Per spegnere un comando in una pagina:
  `<SeScrive>` attorno al pulsante, o `useSolaLettura()`
  (`artifacts/transitintel/src/hooks/use-sola-lettura.tsx`).
- **I progetti restano un controllo a parte.** Il ruolo dice che cosa si può
  fare; quali progetti si vedono lo dice ancora la condivisione del progetto
  (proprietario, membri). Dare «Ufficio turni» a qualcuno non gli apre i
  progetti degli altri: glieli condivide chi li possiede, come prima.
- **Accesso di prima.** Chi c'era prima dei ruoli non cambia accesso il giorno
  del rilascio: i suoi interruttori (Rete, Turni, Roster, Personale, Esercizio,
  Tariffe, Flotta) restano validi come scrittura sulla loro area, e in Utenti e
  accessi compaiono come «accesso di prima». Chi aveva Roster tiene i dati
  sanitari, chi aveva Analisi tiene l'Analisi. Per passare ai ruoli: «Modifica»,
  si danno i ruoli, si toglie la spunta all'accesso di prima, si salva. Una
  volta tolto non si rimette: i diritti nuovi si danno con i ruoli.
- **Un utente nuovo** non ha niente finché non gli si dà un ruolo.
- **Verifica in due passaggi.** Resta obbligatoria per chi vede il personale o
  il roster. Tutti i ruoli tranne Pianificatore e Officina leggono il roster:
  dando uno di quei ruoli a chi non l'aveva, al prossimo accesso dovrà
  attivarla.
- **FleetCare non cambia.** Continua a leggere `users.permissions`, che da qui
  in poi è una vista tenuta dall'API (un interruttore è acceso se l'utente ha
  almeno la lettura sulla sua area) e riallineata a ogni avvio. Non va scritta
  a mano: i diritti stanno in `ruoli`, `accesso_di_prima`, `dati_sanitari` e
  `analisi` (migrazione 0009).
- **I depositi di una persona (PR 2.14c e 2.14d).** Per ogni utente
  l'amministratore sceglie, deposito per deposito, se **modifica** i
  conducenti, li **vede** soltanto, o **non li vede**: è il caso del Capo
  deposito. Si sceglie in Utenti e accessi, alla creazione dell'utente o da
  «Modifica», nel riquadro «Depositi del roster» (compare per chi può aprire
  il roster o il personale).
  - **In testa c'è «Vede i conducenti di tutti i depositi».** Acceso, è
    com'era con la 2.14c: si sceglie solo quali modifica, e nessuno scelto
    vuol dire tutti. Spento, ogni deposito ha le tre scelte, e la persona
    modifica solo quelli segnati «Modifica». Spegnerlo non cambia niente da
    solo: parte da quello che la persona poteva già fare, e l'amministratore
    toglie.
  - **Il giorno del rilascio nessuno cambia quello che vede**: il limite
    comincia quando l'amministratore spegne l'interruttore a qualcuno.
  - **Nel database** sono due elenchi su `users`: `depositi` (quelli che
    modifica, migrazione 0012) e `depositi_visibili` (quelli che vede,
    migrazione 0016; vuoto = tutti). La regola è in `lib/permessi`
    (`limitiSuiDepositi`).
  - **Che cosa non vede** chi ha un limite: i conducenti degli altri depositi,
    da nessuna parte. Elenco e scheda dell'anagrafica, storico, esportazione,
    tabellone, rotazioni dei riposi, e nemmeno i depositi stessi negli elenchi
    da cui si sceglie. Per lui un conducente di un altro deposito è come se
    non ci fosse (404), e un tentativo di scriverci sopra viene rifiutato
    senza dire di che deposito è.
  - **I turni presi da conducenti che non vede** nel tabellone risultano
    occupati, senza dire da chi: altrimenti gli sembrerebbero scoperti.
  - **Che cosa non modifica**: turni assegnati e tolti (anche quello tolto a
    un conducente per darlo a un altro), cambi turno (devono essere dei propri
    depositi tutti e due i conducenti), voci di assenza e presenza, rotazioni
    dei riposi e riposi generati, conducenti fittizi creati da chi non scrive
    il «Personale».
  - **Chi scrive il «Personale»** modifica le schede di tutti i conducenti che
    vede, anche se sul roster ne modifica solo alcuni: i dati del personale
    sono un'altra area. Non mette però un conducente in un deposito che non
    vede, e non fa l'import dell'anagrafica, che tocca tutti i depositi.
  - **Il deposito di un conducente** è la sua residenza di servizio, abbinata
    al catalogo come nel resto dell'anagrafica (nome, codice o alias). Un
    conducente senza deposito lo vede e lo scrive solo chi non ha limiti.
  - L'amministratore non ha mai limiti. I depositi restano scritti anche a chi
    perde la scrittura sul roster: sono un limite, e tornano a valere se la
    riottiene.
  - Lo fa rispettare l'API (`lib/roster-limite-depositi.ts`, 403 con
    `solaLettura`); la regola è in `lib/permessi`. Una rotta nuova che scrive
    il roster di un conducente deve chiamare `fuoriDaiDepositi`.
- **Limiti di questa versione.** Consuntivo e variazioni del giorno sono nella
  matrice ma le pagine non ci sono ancora.
- **Tornare indietro.** Con l'immagine precedente l'app legge di nuovo
  `users.permissions` come «può tutto» sul modulo: chi nel frattempo ha
  ricevuto un ruolo di sola lettura tornerebbe a poter scrivere sui moduli che
  legge. Se si torna indietro dopo aver assegnato ruoli, vanno ricontrollati
  gli interruttori in Gestione Utenti.

- **Oggi** (`/oggi`) è la pagina d'ingresso. Mostra il servizio adesso dall'AVM,
  i turni del giorno nel roster (pubblicati, scoperti, assenze), il programma in
  esercizio e l'ultima pubblicazione dei turni; ognuno vede solo i riquadri dei
  suoi permessi. Dopo l'accesso si torna alla pagina chiesta (un segnalibro, un
  link); una pagina senza permesso riporta a Oggi e dice quale permesso serve.
- **Ogni API ha la sua area (deny by default).** Un percorso che non ha una
  voce in `AREE_PER_PREFISSO` (`lib/permessi-rotte.ts`) risponde 403 a chi non è
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
  l'admin cambia sugli utenti: creazione ed eliminazione, ruolo di sistema,
  ruoli aziendali, accesso di prima, dati sanitari e Analisi (solo i nomi
  aggiunti e tolti), ruolo FleetCare, nome (solo che
  è cambiato, non il valore), oltre a password provvisoria, verifica tolta,
  sblocco, disattivazione e riattivazione.
- **Analisi parte spenta per i nuovi utenti.** Chi la aveva la tiene: l'admin la
  toglie da Gestione Utenti a chi non la usa. Le letture che servono anche agli
  altri moduli (feed e fermate per i turni, linee e confini per le tariffe, il
  dominio dei QR per la stampa orari, l'elenco dei programmi per i turni) non
  dipendono più da Analisi. Il default della colonna lo allinea la migrazione
  `0001_allinea` (in produzione era rimasto quello iniziale); conta solo per
  chi inserisce utenti a mano, perché l'app scrive i permessi per intero.
- **Rete e orari portava con sé i Turni** quando i permessi erano interruttori:
  chi li ha ancora come accesso di prima li ha tutti e due. Con i ruoli non
  vale più: il Pianificatore scrive la rete e legge i turni.
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
  l'utente può aprire, come gli elenchi della Fucina.
- **La vecchia pagina dei turni guida** (`/driver-shifts/…`) non c'è più: tutto
  quello che faceva è nella pagina dei turni guida della Fucina
  (`/fucina/<progetto>/drivers/<scenario>`), e i link salvati al vecchio
  indirizzo portano lì.

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
