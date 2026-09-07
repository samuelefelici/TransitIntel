# Argos · stato dei lavori (Domenica Ancona)

Nota di passaggio fra sessioni: chi riprende parte da qui, senza ricostruire il contesto dalla chat.
Aggiornata al 7 settembre 2026, 14:40 UTC.

## Progetto e vincoli di test

- Progetto Planning Studio «Domenica Ancona»: `fe78db8e-11b9-4ac9-bdb2-a21ef9892244`, giorno-tipo festivo, data di esercizio di prova 2026-09-20, 17 linee urbane, 365 corse festive.
- **Solo il deposito di Ancona** (`b2f3de29-aa93-4d02-adcb-b866f0581998`) in ogni giro: `depotIds` sempre valorizzato. Gli altri depositi (Jesi ecc.) hanno tratte senza arco in archivio.
- Parametri del giro di riferimento: `date 2026-09-20, mode vcsp, serviceType urbano, companyCars 5, defaultVehicleType 12m, crewShiftScope trip, shiftPenaltyEur 1`; per il giro «a regola d'arte»: `intensity deep, rounds 3, probes 10, crewTimeLimit 600, crewSolverIntensity 3, crewMaxRounds 10, crewWeights {minDrivers 10, preferIntero 10, minSupplementi 10, qualityTarget 3, workBalance 1, minCambi 1}`.

## Regole dell'azienda recepite nel motore

- BDS: intero ≤ 7:15; semiunico ≤ 9:15 con interruzione ≥ 1:15; spezzato ≤ 10:30 con interruzione ≥ 3:00; **massimo 5 autovetture aziendali** (vincolo rigido); domenica: più interi possibile.
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

## In sospeso

- Ruotare la chiave di scrittura MCP (`MCP_WRITE_KEY`) a fine giornata: mai incollarla in chat.
- Decidere sulle tre proposte del quadro (3R 20:47, 30A 21:12, 3R 08:17) e sullo spostamento di 15′ proposto dalla sonda del giro Y.
- Leggere l'audit festivo completo con `ti_round_trip_audit` (dalla salute: 16 anomalie su 362 corse prima delle correzioni).
