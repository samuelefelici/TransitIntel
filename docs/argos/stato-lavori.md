# Argos · stato dei lavori (Domenica Ancona)

Nota di passaggio fra sessioni: chi riprende parte da qui, senza ricostruire il contesto dalla chat.
Aggiornata al 7 settembre 2026, 14:40 UTC.

## Progetto e vincoli di test

- Progetto Planning Studio «Domenica Ancona»: `fe78db8e-11b9-4ac9-bdb2-a21ef9892244`, giorno-tipo festivo, data di esercizio di prova 2026-09-20, 17 linee urbane, 365 corse festive.
- **Solo il deposito di Ancona** (`b2f3de29-aa93-4d02-adcb-b866f0581998`) in ogni giro: `depotIds` sempre valorizzato. Gli altri depositi (Jesi ecc.) hanno tratte senza arco in archivio.
- Parametri del giro di riferimento: `date 2026-09-20, mode vcsp, serviceType urbano, companyCars 5, defaultVehicleType 12m, crewShiftScope trip, shiftPenaltyEur 1`; per il giro «a regola d'arte»: `intensity deep, rounds 3, probes 10, crewTimeLimit 600, crewSolverIntensity 3, crewMaxRounds 10, crewWeights {minDrivers 10, preferIntero 10, minSupplementi 10, qualityTarget 3, workBalance 1, minCambi 1}`.

## Regole dell'azienda recepite nel motore

- BDS: intero ≤ 7:15; semiunico ≤ 9:15 con interruzione ≥ 1:15; spezzato ≤ 10:30 con interruzione ≥ 3:00; **massimo 5 autovetture aziendali — inviolabile** (il progetto è configurato a 6: passare `companyCars: 5` esplicito a ogni giro finché non viene corretto); domenica: più interi possibile.
- Costo del conducente: **27 €/ora**. Corrispettivo: **2,60 €/km su TUTTI i km**, di linea e di fuorilinea. Un fuorilinea non è quindi una perdita: 10 km rendono 26 €, costano ~9,50 € di mezzo e ~13,50 € di conducente. Quello che costa davvero sono **le ore pagate**.
- Tetti percentuali di semiunici e spezzati rigidi, sforabili al massimo di 0,9 turni entro l'unità intera; base di calcolo = turni senza i supplementi (modello e stato allineati).
- Bus mai incustodito oltre 15′; il montante prende il bus all'arrivo (sosta ≤ 30′ coperta); ogni cambio scritto nel turno («In [nodo] lascia/prende la vettura al turno …»).
- Fuorilinea solo dall'archivio di Planning Studio, stesso tempo in andata e ritorno; rientri in deposito reali; corse di rientro in linea proposte al posto dei vuoti.
- Regola del giro sulle linee radiali: dal capolinea periferico si riparte con la corsa di ritorno dello stesso bus.
- **Nel servizio urbano non esistono** né il tetto di guida per ripresa (4h30) né la guida continuativa RD 131: entrambi spenti con `serviceType urbano`, salvo attivazione esplicita in `bds.riprese.maxGuidaPerRipresa` / `bds.rd131.attivo`.
- Codici dei turni guida: lettera del deposito + tre cifre, 001–099 mattinali (inizio nastro prima delle 12:00), 100–199 pomeridiani (es. A005).
- Fogli turno: una pagina A4 per turno (voce «Fogli turno» nel menu Esporta e dalla card del singolo turno); accanto alla matricola c'è il tipo di mezzo.
- **Regola della sagoma.** Il tipo dichiarato su una linea è il mezzo giusto **e insieme il suo tetto fisico**: sopra quella taglia la strada non regge. Scala: autosnodato (18 m) → 12 m → 10 m → pollicino. Quindi:
  - **mai un mezzo più grande** del dichiarato (non è spreco: non passa);
  - si può **declassare di un gradino solo**, mai due (il pollicino non fa una corsa da 12 m: sarebbe un doppio declassamento);
  - un blocco di una certa taglia serve solo le linee della propria taglia e quelle di **una** taglia superiore, queste ultime declassate;
  - il declassamento è **l'ultima spiaggia**, non la norma: una corsa isolata fuori punta non fa danno, venti sì. Tetti di riferimento: 10% delle corse della linea, 5% in punta;
  - quando la sagoma impedisce di allungare un blocco, **non si piega il blocco: si muove il conducente** con un cambio, che deve stare dentro i cluster e lasciare il mezzo fermo non oltre 15′;
  - un cambio in più vale la pena se fa risparmiare un mezzo.
  - Ad Ancona: pollicino, 10 m, 12 m, autosnodato (solo 1/4 e 10). Massimo **3 pollicini**, nessun tetto sugli altri tipi. Tutti i conducenti guidano tutti i tipi.
  - Domenica la punta è **il pomeriggio** (15:00–20:00), non mattina e sera: fasce configurabili in `config.sagoma.fascePunta`.

## Ordine di ragionamento dell'operatore (come si costruisce un piano)

Dettato dall'operatore, ed è l'ordine da seguire quando si lancia e si giudica un giro:

1. **Riempire i turni macchina** di corse della giusta dimensione di mezzo, cercando la **saturazione massima** e riducendo al minimo il numero di vetture.
2. **Creare i turni guida** su quei blocchi.
3. **Spostare corse fra turni macchina diversi** per ridurre o migliorare i turni guida. È il passo che si salta più facilmente, ed è quello che risolve i problemi di cambio.
4. Solo se non basta, **spostare corse in pianificazione**: spostamenti mirati, sapendo che effetti generano su TM e TG.

Nel motore: il passo 3 è il ciclo VSP↔CSP a costi-ombra dell'orchestratore VCSP, il passo 4 è la sonda di spostamento (oggi timidissima: accetta 0–2 spostamenti su 4 prove).

## Il piano festivo REALE di Ancona, come metro di paragone

Da `AN_Festivo_Invernale_2026.pdf`, 38 fogli turno veri:

| | Piano umano | Nostro giro AF |
|---|---|---|
| Turni guida | 38 (37 Interi + 1 supplemento) | 37 |
| Turni macchina | 21 | 19 |
| Semiunici / spezzati | **0 / 0** | 5 / 2 |
| Nastro totale | 244h19 (media 6h25) | — |
| Scambi di vettura | 42 | 29 |
| **Trasferimenti in auto** | **8** | tutti i 29 |
| Fuorilinea | 88 | — |

**La lezione più importante di tutte.** Loro fanno PIÙ scambi di noi e consumano UN QUINTO delle auto. Il meccanismo sta nelle note dei fogli: «(A) = Consegnare la vettura al A011», «(B) = Ritirare la vettura dal A011». I turni **iniziano e finiscono in deposito** — il conducente porta fuori il bus e lo riporta dentro (88 fuorilinea) — e lo scambio avviene fra due conducenti **già entrambi al nodo**. Costo in autovetture: zero.

Nel nostro modello `_walk_partner` (`crew_scheduler_v3.py:1138`) cerca il compagno di scambio **solo dentro lo stesso turno**: in ogni altro caso chiama l'auto. Manca la mossa del deposito, ed è la causa di tutti gli sforamenti del tetto auto della serie AA–AF. **Non è una taratura, è un pezzo di modello mancante.**

Dove lasciano valore loro: nastri fra 6h11 e 6h58 contro un tetto di 7h15, cioè **31h11 di margine non usato** — a nastro pieno basterebbero 33,7 turni invece di 38. Obiettivo: **≤ 34 turni guida e < 21 turni macchina**.

Altro meccanismo che non abbiamo: la **Riserva** (4 casi, 4h45) — conducente fermo in deposito, pagato, dentro un turno che resta Intero.

## Serie di giri Z → AF (regola della sagoma)

| Giro | Vetture | Turni | Auto (tetto 5) | Incustodito | Note |
|---|---|---|---|---|---|
| Y | 18 | 40 | 5/5 ✓ | 15′ ✓ | prima della sagoma |
| Z | 21 | 43 | — | — | sagoma accesa, 28,5% declassate |
| AA | 19 | 43 | 8 ❌ | 105′ ❌ | 1/4 inchiodata al 12 m |
| AB | 19 | 43 | 7 ❌ | 81′ ❌ | più tempo al solver guida: non basta |
| AC | 28 | 42 | 5 ✓ | 15′ ✓ | giunti mirati, penalità troppo care |
| AD | 19 | 43 | 6 ❌ | 81′ ❌ | penalità ricalibrate |
| AE | 24 | 42 | 5 ✓ | 15′ ✓ | escalation delle penalità |
| **AF** | **19** | **37** | 7 ❌ | 105′ ❌ | scarsità delle auto; miglior piano, batte quello umano su vetture e turni |
| AG | 19 | 38 | 7 ❌ | 105′ ❌ | km a vuoto pagati (#456): **nessun effetto**, 169,5 km contro 171,2 |
| AH | 26 | 41 | **5 ✓** | **15′ ✓** | taglio in deposito ammesso (#457): regole rispettate, ma 7 vetture in piu' e 32,3% di declassate |
| AI | 19 | 37 | 7 ❌ | 105′ ❌ | prima misura di `cambiInDeposito`: **1 su 33**. Risposta: (b) |

Nessun giro ha mai prodotto un mezzo fuori sagoma o un doppio declassamento.

**Correzione di un mio errore di lettura.** Avevo letto in `handoverModes` di AG «29 in auto, 3 a piedi, zero in deposito» e l'avevo presentata come la prova che il motore non faceva mai un cambio in deposito. Quel numero non puo' dire questo: `handoverModes` e `totalCambi` sono calcolati su `inline_handovers()` (`crew_scheduler_v3.py:1247`), che **scarta per costruzione** i cambi in deposito. Il numero vero e' `totalDepotChanges` (`crew_scheduler_v4.py:4720`), che **non era esposto da nessuna parte**: ne' dalla risposta compatta dell'api-server ne' dal cruscotto MCP. Per otto giri abbiamo giudicato alla cieca il numero che conta di piu'. Ora e' esposto in entrambi i punti.

Il difetto trovato e corretto con la #457 resta reale e dimostrato eseguendo il codice (il taglio in deposito fuori cluster nasceva a −5,1 e veniva cancellato da `filter_cuts_by_cluster`): e' la prova che era sbagliata, non la conclusione.

## Scenari salvati (Cerbero → Fucina)

| Giro | Scenario | Esito |
|---|---|---|
| W | `91060104-d307-4495-96f9-4e7b8edbad70` | 18 vetture, 40 turni, 0 suppl., 16.367 €, quadro non ancora corretto |
| X | `f23d4ecc-cf52-4f03-b3cd-c78993984578` | codici A001/A100 in linea, 361 corse (UDP non allineata), 16.355 € |
| **Y** | `239b91b3-39a4-4948-940d-09ce6952e3e2` | **365 corse, 18 vetture, 40 turni (35 interi, 5 semiunici, 0 spezzati, 0 suppl.), 196 km a vuoto, 153 giri naturali su 167, auto 5/5, incustodito ≤ 15′, 16.093 €** |

Segnalazioni residue nel giro Y: 2 turni interi senza sosta ≥ 15′ al capolinea; 12 proposte di rientro in linea; la sonda propone lo spostamento di una corsa di 15′ (da approvare).

## Quadro orario festivo: correzioni fatte

- 93: la corsa delle 20:02 su variante senza codice non è più festiva; nuova 93R 20:02 → 20:39; 93R 07:47 → 08:15 e 14:47 → 14:50.
- 30: nuova 30R 06:46 da Torrette.
- 3: nuove 3R 08:47 e 21:47; 3R 07:17 → 07:52.
- 2/6: 2/6R 07:44 → 08:04, 08:44 → 09:04, 21:54 → 22:04.
- 24: le 10 corse 24RD da xx:03 a xx:09.

Proposte non ancora approvate: 3R 20:47 (la 3A 20:20 arriva alle 20:42); 30A 21:12 (alimenta la 30R 21:46); sorte della 3R 08:17, rimasta senza andata dopo l'aggiunta della 08:47.

## Strumenti e flusso

- Giri: `ti_vcsp_run` (la UDP superata si riallinea da sola al lancio; la risposta porta `udpRefresh`) e `ti_vcsp_status` (sezione `kpi` predefinita, ~500 token; `summary`, `crew`, `probe`, `rounds` a richiesta). Il registro dei giri è sul database: gli esiti sopravvivono ai deploy, un giro interrotto da un riavvio si dichiara con la richiesta per rilanciarlo.
- Quadro: `ti_round_trip_audit` (anomalie di giro per linea e giorno-tipo), `ti_apply_plan_fixes` (lotto di spostamenti, generazioni e bollini in una chiamata, dopo il sì esplicito), `ti_line_timetable`, `ti_project_health` (controllo `round_trip_gaps`).
- Ogni scrittura sul piano richiede la descrizione dell'intervento e il sì esplicito dell'utente; gli spostamenti (`ti_shift_trip`) un secondo sì. Mai creare fermate.
- Deploy: TransitIntel al merge su `main`; Argos (Coolify) al push su `claude/argos-planner-engine-d3a387` (base delle PR: `claude/beautiful-faraday-8q8iis`). Il connettore Argos rilegge l'elenco dei tool solo alla riconnessione.

## Regole a basso consumo di token

1. Nessuna sorveglianza automatica delle PR e nessun check-in periodico: l'utente merge e avvisa.
2. Un giro per lotto di modifiche, mai durante un merge: il processo del solver muore col riavvio del container.
3. Una sola lettura per giro, con la sezione `kpi`; `crew` solo se richiesto.
4. Correzioni del quadro in un unico lotto con `ti_apply_plan_fixes`.
5. Nuova sessione per ogni nuovo filone di lavoro, partendo da questa nota.

## La catena completa del problema «autovetture» (diagnosi chiusa)

1. Il conducente puo' passare da un pezzo all'altro **senza auto** se il pezzo inizia con l'uscita del bus dal deposito o finisce col suo rientro: `seg_transfer_out` / `seg_transfer_back` (`crew_scheduler_v4.py:1138-1152`) azzerano il trasferimento in quel caso. **Il meccanismo c'e' gia'.**
2. Ma un pezzo puo' iniziare o finire in deposito **solo se il turno macchina ci passa** (`starts_at_depot` / `ends_at_depot`, `crew_scheduler_v4.py:1783-1854`).
3. E il VSP **evita** i passaggi in deposito, perche' li prezza come costo puro: `per_depot_return` 15 € piu' i km a vuoto (0,75-1,20 €/km).
4. Ma i km a vuoto sono **pagati 2,60 €/km** come quelli di linea. Un rientro in deposito non e' una perdita: e' compensato.

Quindi il motore fugge da una cosa che rende, i blocchi restano fuori tutto il giorno, i tagli dei turni guida cadono in linea, e serve un'auto per ogni cambio. **E' l'anello che chiude la diagnosi**: non manca il modello della mossa del deposito, manca il prezzo giusto dei km a vuoto.

Regole confermate dall'operatore (8 settembre):
- il rientro del bus in deposito a meta' turno e la successiva uscita sono **lavoro pagato normale, al 100%**;
- la **riserva** NON e' un riempitivo di buchi: si mette su un turno intero povero di corse per avere qualcuno **disponibile** a coprire il pezzo di un assente o a spostare vetture. E' una risorsa di scorta, non un pezzo di turno;
- la **codifica dei turni** resta la nostra (A + 3 cifre, 001-099 mattinali, 100-199 pomeridiani): il piano reale e' numerato alla vecchia maniera e non fa testo.

## Il quinto anello: il taglio in deposito era VIETATO (trovato col giro AG)

Il prezzo dei km a vuoto (#456) era necessario ma non sufficiente: i km a vuoto non si sono mossi (169,5 contro 171,2) e le auto sono rimaste 7 su 5. Il motivo e' a monte di ogni calcolo economico.

In `analyze_vehicle_block` (`crew_scheduler_v4.py`) ogni punto di taglio nasceva con:

    allows_cambio = cid is not None          # cid = cluster della fermata

e subito dopo `filter_cuts_by_cluster` (attiva per default, `cutOnlyAtClusters`) **cancellava** ogni candidato con `allows_cambio` falso. Il taglio al passaggio in deposito riceveva gia' il suo bonus (`CUT_DEPOT_BONUS + CUT_NO_CLUSTER_PENALTY`, cioe' l'intenzione dell'autore era chiara), ma se il capolinea da cui partiva il rientro non era in un cluster veniva **buttato via prima di poter competere**. Ad Ancona i rientri a meta' blocco partono da Montesicuro, Ospedale, Scataglini, Madonnetta: nessuno di questi e' un cluster. Da qui i cambi in deposito a zero.

Misurato sul banco (capolinea periferico fuori cluster): punteggio **−5,1 e cancellato** → **17,4 e ammesso**; il cambio che ne nasce e' `depot`/`depot`, trasferimento 0, **auto 0, incustodito 0**.

La correzione, in `analyze_vehicle_block`:
- `allows_cambio = cid is not None or is_depot_cut` — un passaggio in deposito e' per definizione un punto di cambio: chi smonta ci arriva **guidando** il bus, chi monta riparte **guidandolo** fuori;
- `transfer_cost = 0` al taglio in deposito (non c'e' nessun trasferimento da pagare);
- la penalita' radiale (`CUT_SAME_ROUTE_PENALTY`, fino a −22,5) non si applica: difende dal cambio al capolinea periferico, che costerebbe un'auto e lascerebbe il bus incustodito — al deposito non accade ne' l'una ne' l'altra cosa.

`compute_car_pool` e `seg_transfer_out`/`seg_transfer_back` erano gia' corretti: una volta che il pezzo ha un bordo in deposito, l'auto non viene piu' prenotata. Nessuna modifica li'.

## Il giro AH e la lettura onesta

Col taglio in deposito ammesso (#457) **le due regole rigide rientrano per la prima volta**: autovetture 5 su 5 con zero conflitti e zero turni senza auto, vettura incustodita 15′ esatti. Le violazioni BDS scendono da 6 a 1, i tetti percentuali sono rispettati **senza rilassamento** (era la prima volta), e la forma dei turni migliora molto: 34 interi, 5 semiunici, 1 spezzato, 1 supplemento, nastro medio 371′ contro 414′.

Ma il prezzo e' alto e va detto: **26 vetture invece di 19** (il piano umano ne usa 21), km a vuoto 214,4 contro 169,5, e soprattutto il declassamento esplode: **32,3%** contro il 17% di AG, con **5 pollicini** contro i 2-3 dichiarati dall'operatore e 8 catene spezzate. La 91 e' declassata all'83%, la 2/6 al 54%.

E c'e' una spiegazione piu' banale del merito della #457: la ripartizione dei blocchi passa da 17 LUNGO / 1 MEDIO / 0 CORTO a 11 LUNGO / 4 MEDIO / **10 CORTO**. Un blocco corto non ha bisogno di nessun taglio, quindi niente cambio e niente auto. Le auto possono essere rientrate cosi', non perche' i cambi siano passati in deposito. Senza `totalDepotChanges` non si distinguono i due casi — ed e' esattamente il motivo per cui va esposto.

## Il giro AI: la risposta e' (b), e la causa e' a monte di ogni prezzo

Primo giro con `cambiInDeposito` visibile: **1 cambio in deposito su 33** (32 in linea). AI e' tornato alla forma di AG — 19 vetture, 37 turni, blocchi 17 LUNGO / 1 MEDIO / **0 CORTO**, auto 7 su 5, incustodito 105′ — quindi la conformita' di AH veniva dallo spezzare i blocchi (10 CORTO), non dai cambi in deposito.

La #457 ha tolto il divieto, ma l'occasione quasi non esiste. Il motivo e' in `precompute_arc_costs` (`vehicle_scheduler_cpsat.py:928-980`): il passaggio in deposito fra due corse viene generato in **due soli casi, entrambi forzati**:

1. `dh_km >= DH_FORBIDDEN_KM` — il riposizionamento diretto e' vietato dall'archivio fuorilinea, il bus e' costretto a passare dal deposito;
2. `gap > rates.max_idle_at_terminal` — e quella soglia vale **240 minuti**.

Non c'e' un terzo ramo. Il motore non genera **mai** l'arco via deposito come *alternativa* a un collegamento diretto legale: quando il diretto esiste e la sosta sta sotto le quattro ore, l'opzione non entra nemmeno nel modello. Un bus puo' restare fermo a un capolinea fino a **quattro ore** prima che il motore consideri di mandarlo a casa — e in quelle ore serve un conducente che lo aspetti o un'autovettura che porti il cambio.

Questo spiega anche perche' la #456 non aveva mosso nulla: prezzare bene i km a vuoto non serve se la mossa non e' fra le alternative. Non era un problema di prezzo, era un problema di **arco mancante**.

**Fatto (soglia data dall'operatore: soste oltre 30 minuti).** L'arco via deposito ora entra fra le alternative e vince solo se costa meno dell'attesa. Perche' il confronto fosse onesto mancava una voce: la regola aziendale dice che la vettura non puo' restare sola piu' di 15 minuti, quindi ogni minuto oltre quel limite lo paga qualcuno — il conducente che resta col mezzo, o un'autovettura che porta il cambio. Senza quella voce un'attesa di tre ore costava 38 € di sosta contro i 72 € di nastro che consuma davvero, e tenere il bus fuori sembrava sempre conveniente.

Misura sul banco, con un rientro tipico di Ancona (10 km, 30′ di guida, 16,50 €):

| sosta | aspetta | in deposito | sceglie |
|---|---|---|---|
| 30′ | 8,61 € | 16,50 € | aspetta |
| 45′ | 18,81 € | 16,50 € | **deposito** |
| 90′ | 49,41 € | 16,50 € | **deposito** |
| 180′ | 110,61 € | 16,50 € | **deposito** |

Il punto di pareggio (~40-45′) **non e' fissato a mano: esce dalla distanza del deposito**. Un capolinea vicino manda il bus a casa prima, uno lontano lo tiene fuori piu' a lungo — la stessa regola da' risposte diverse dove la citta' e' diversa.

## Il prossimo intervento (superato dal precedente)

**Il prezzo dei km a vuoto nel VSP.** Vedi la catena qui sopra: la mossa del deposito e' gia' implementata e gratuita, ma non viene mai usata perche' il VSP evita i passaggi in deposito. Vanno prezzati al NETTO del corrispettivo (2,60 €/km incassati contro 0,75-1,20 di costo), tenendo come costo vero il tempo del conducente (27 €/ora), che e' l'unica cosa che si spende davvero. Attenzione a non ribaltare l'incentivo: se i km a vuoto diventano profitto il solver ne inventerebbe, e il freno deve restare il tempo pagato.

Togliendo questa causa si possono togliere anche le due medicine messe nella notte del 7-8 settembre, che rendono l'auto cara invece di renderla inutile:

- la maggiorazione di scarsita' `company_car_scarcity_eur` (20 €, PR #454);
- l'escalation delle penalita' sui giunti (×2,5 fino a ×8, PR #453).

## In sospeso

- Ruotare la chiave di scrittura MCP (`MCP_WRITE_KEY`) a fine giornata: mai incollarla in chat.
- Decidere sulle tre proposte del quadro (3R 20:47, 30A 21:12, 3R 08:17) e sullo spostamento di 15′ proposto dalla sonda del giro Y.
- Leggere l'audit festivo completo con `ti_round_trip_audit` (dalla salute: 16 anomalie su 362 corse prima delle correzioni).
