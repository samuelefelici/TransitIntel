# 🚀 TransitIntel — Guida Deploy (Coolify, self-hosted)

## Architettura Produzione

```
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│  Web (Dockerfile.web)│────▶│  API (Dockerfile.api)│────▶│  PostgreSQL          │
│  React + Vite build  │     │  Express + Node 20   │     │  self-hosted         │
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
| **Database** | immagine PostgreSQL di Coolify | 5432 | schema da `setup.sql` + `migrations/` |
| **API** | `Dockerfile.api` (repo) | 3000 | start: `node artifacts/api-server/dist/index.cjs` |
| **Web** | `Dockerfile.web` (repo) | 80 | nginx serve la SPA (`artifacts/transitintel/dist`) |

---

## STEP 1: Database — PostgreSQL su Coolify

1. Nel progetto Coolify: **+ New → Database → PostgreSQL** (versione 15+).
2. Scegli nome, utente e password; avvialo.
3. Annota l'**hostname interno** del servizio (Coolify lo espone agli altri
   servizi dello stesso progetto via rete privata) e l'eventuale **URL pubblico**.
4. Applica lo schema. Da un client con accesso al DB:
   ```bash
   psql "$DATABASE_URL" -f setup.sql
   psql "$DATABASE_URL" -f migrations/2026-05_caronte_and_stop_classification.sql
   psql "$DATABASE_URL" -f migrations/2026-06_operations_live.sql   # Sala Operativa + GTFS-RT
   # opzionale, validatore Caronte:
   psql "$DATABASE_URL" -f caronte_setup.sql
   ```
   > In alternativa puoi incollare il contenuto degli `.sql` in un SQL editor.
   > Lo schema cambia **solo** con i file di `migrations/`: `drizzle-kit push` è
   > disattivato, perché proporrebbe di cancellare le tabelle che l'API crea da sé.
   > Alcune tabelle (es. polimetriche, snapshot) vengono create **lazy**
   > dall'API al primo uso (`CREATE TABLE IF NOT EXISTS`), quindi non serve
   > una migration manuale per quelle.

> ✅ Conserva la connection string. Forma tipica su rete interna Coolify (senza SSL):
> `postgres://user:password@<servizio-db>:5432/dbname`
> Se il DB è esposto pubblicamente con certificato self-signed, usa
> `?sslmode=no-verify` **oppure** imposta `PGSSL_NO_VERIFY=1` (vedi env).

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
   - `CRON_SECRET` (genera con `openssl rand -hex 32`)
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
   es. `https://api.transitintel.tuodominio.it`. Verifica `GET /api/healthz`.

> L'API ha bisogno di **Python + OR-Tools** per gli scheduler: ci pensa
> `Dockerfile.api` (installa `python3` e fa `pnpm run build:deploy`, che include
> `install:python`). Non serve configurare nulla a mano.

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
Anagrafica). Le tabelle si creano da sé al primo avvio; il file
`migrations/2026-10_anagrafica_personale.sql` è lo specchio per chi le vuole
preparare prima.

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
creano da sé; `migrations/2026-10_roster_riposi.sql` è lo specchio.

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
creano da sé; `migrations/2026-10_roster_pubblicazione.sql` è lo specchio.

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
| Amministrazione | Utenti e accessi (admin), Dati e integrazioni (Analisi o Esercizio), Sicurezza dell'account | — |

- **Oggi** (`/oggi`) è la pagina d'ingresso. Mostra il servizio adesso dall'AVM,
  i turni del giorno nel roster (pubblicati, scoperti, assenze), il programma in
  esercizio e l'ultima pubblicazione dei turni; ognuno vede solo i riquadri dei
  suoi permessi. Dopo l'accesso si torna alla pagina chiesta (un segnalibro, un
  link); una pagina senza permesso riporta a Oggi e dice quale permesso serve.
- **Analisi parte spenta per i nuovi utenti.** Chi la aveva la tiene: l'admin la
  toglie da Gestione Utenti a chi non la usa. Le letture che servono anche agli
  altri moduli (feed e fermate per i turni, linee e confini per le tariffe, il
  dominio dei QR per la stampa orari, l'elenco dei programmi per i turni) non
  dipendono più da Analisi. `migrations/2026-11_analisi_spenta.sql` cambia solo
  il default della colonna: non serve applicarla, l'app scrive i permessi per
  intero quando crea un utente.
- **Rete e orari porta con sé i Turni**, come prima. All'avvio l'app allinea chi
  aveva Rete e orari senza Turni (salvato prima che la regola valesse anche al
  salvataggio): da lì in poi vede anche i Turni.
- **Orari al pubblico** si apre sul programma in esercizio; prima chiedeva il
  permesso Analisi, ora Rete e orari (è lì che si leggono gli orari).
- **Ipotesi di linea** (gli scenari KML) ora chiede Analisi, come le sue API.
  **Dati e integrazioni** si apre con Analisi (i feed GTFS) o con Esercizio (le
  paline Mizar); la sincronizzazione delle sorgenti resta dell'admin. Il numero di autovetture aziendali usato
  dai motori dei turni si cambia solo da admin.
- I vecchi indirizzi portano ai nuovi: `/network-engine` → Planning Studio,
  `/fares-engine` e `/stops-classification` → Bigliettazione, `/fucina` e
  `/optimizer-*` → Progetti di esercizio. La vecchia pagina dei turni guida
  (`/driver-shifts/…`) resta raggiungibile dai link della Fucina, fuori dal menu.

---

## Variabili d'Ambiente

Riferimento completo in `.env.example`. Sintesi:

### API (`Dockerfile.api`) — runtime

| Key | Obbligatoria | Note |
|---|---|---|
| `DATABASE_URL` | ✅ | `postgres://user:pass@<servizio-db>:5432/dbname` |
| `PGSSL_NO_VERIFY` | — | `1` se Postgres usa certificato self-signed |
| `NODE_ENV` | ✅ | `production` |
| `PORT` | ✅ | `3000` |
| `JWT_SECRET` | ✅ | `openssl rand -hex 32` |
| `CRON_SECRET` | ✅ | `openssl rand -hex 32` (header `x-cron-secret`) |
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
| `COPILOT_MODEL` | — | override modello provider AI |
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

Per ogni job: metodo **POST**, header `x-cron-secret: IL-TUO-CRON-SECRET`.

Il controllo settimanale AVM non ha bisogno dello scheduler esterno: con il
connettore SIRI attivo, il processo dell'API controlla ogni ora se c'è una
settimana chiusa senza controllo archiviato e la calcola (il primo giro dopo
le 03:00 di lunedì). L'endpoint serve solo a chi vuole lanciarlo da fuori; è
idempotente. L'archivio è la tabella `caronte.avm_controllo_settimanale`
(`migrations/2026-10_avm_controllo_settimanale.sql`), che l'API crea da sé.

---

## Dev Locale

```bash
# Installa dipendenze
pnpm install

# Crea .env dalla template e compila i valori
cp .env.example .env

# Avvia backend
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
