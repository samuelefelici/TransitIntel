# Schema NeTEx EPIP del profilo italiano

Lo schema con cui Cerbero controlla il NeTEx che esporta (tappa 6.2,
`src/lib/netex-validazione.ts`, con `xmllint`). Il livello 1 del profilo
italiano del NeTEx coincide con il profilo europeo EPIP (UNI CEN/TS 16614-4:2021).

## Provenienza

Copiati senza modifiche dal repository del profilo italiano
`5Tsrl/netex-italian-profile` (ramo `main`, cartella `xsd/`), il 17 novembre 2026:

| File | SHA-256 |
|---|---|
| `NeTEx_publication_EPIP.xsd` | `947d40909d30aef91c7a9e9a1c024cc5aa73d92c36f508435f63aec0522eb431` |
| `_content_NeTEx_EPIP.xsd` | `9aaf85bc6030e49c98bcc45c9d05a22be661298b83b151d827dbfb203ebed5a7` |
| `gml_combo_v3_2_1_simplified.xsd` | `0152aa5edf9008211e1e403615dfc4bf34d2504f6dae5d5fe12daa8335f4c13e` |

Riferimento per la compilazione: «Linee guida per la compilazione del profilo
italiano del NeTEx (Network Timetable Exchange)», versione 4.0.1, 11 marzo 2024.

## Licenze

- Lo schema EPIP è un estratto semplificato dello schema NeTEx ufficiale:
  «Copyright CEN, Crown Copyright 2009-2021», come dice l'intestazione dei
  file. Lo schema NeTEx ufficiale (repository `NeTEx-CEN/NeTEx`) è distribuito
  con licenza GNU GPL v3: il testo è in `LICENSE-NeTEx-GPL-3.0.txt`.
- `gml_combo_v3_2_1_simplified.xsd` riporta il copyright dell'Open Geospatial
  Consortium (http://www.opengeospatial.org/legal/).

Sono dati letti da un programma esterno (`xmllint`), non codice di Cerbero.
Per aggiornarli: si riscaricano dalla stessa fonte, si aggiornano le impronte
qui sopra, e il test `src/__tests__/netex.test.ts` deve passare.
