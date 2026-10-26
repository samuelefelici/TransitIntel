# migrations/ (vecchio)

Qui c'erano gli «specchi» SQL del DDL che l'API eseguiva da sé, da applicare a
mano. Non servono più: dal 25/10/2026 lo schema cambia solo con le migrazioni
versionate di [`lib/db/migrations/`](../lib/db/migrations/README.md), che
l'API applica all'avvio. Il loro contenuto è nel baseline (`0000_baseline`,
lo schema della produzione) o nella `0001_allinea`, tranne due indici che in
produzione non erano mai arrivati e non sono stati ricreati:
`caronte.idx_caronte_active_trips_open` (lo copre già `active_trips_open_idx`)
e `caronte.idx_caronte_transit_route`. La storia dei file resta in git.
