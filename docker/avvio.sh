#!/bin/sh
# Avvio del container di Cerbero (Dockerfile.api): l'API (CERBERO_PROCESSO=api,
# il default) o il lavoratore dei calcoli (CERBERO_PROCESSO=lavoratore).
# API: prima le migrazioni, poi l'API. Se le migrazioni falliscono il container non
# parte (fail-closed): con l'healthcheck Coolify tiene in servizio quello
# vecchio. Il database non cambia, perché la transazione è annullata.
#
# tini manda i segnali solo a questo sh: durante le migrazioni li inoltriamo a
# node, così un arresto annulla la transazione invece di uccidere il migratore
# di colpo. Dopo, `exec` fa diventare l'API il figlio diretto di tini.
#
# Il container parte come root (Dockerfile.api) solo per le migrazioni: l'API e
# il lavoratore girano come l'utente node, senza DATABASE_MIGRATOR_URL
# nell'ambiente. Così né loro né i solver Python che lanciano possono leggere
# le credenziali del migratore (un superutente del database): quelle di tini,
# il PID 1, sono di root (/proc/1/environ non è leggibile da node).
set -u

# esegue il comando come l'utente node (se si è root), con exec: diventa il
# figlio diretto di tini e riceve i segnali
come_node() {
  if [ "$(id -u)" -eq 0 ]; then
    export HOME=/home/node USER=node LOGNAME=node
    exec setpriv --reuid=node --regid=node --init-groups --no-new-privs -- "$@"
  fi
  exec "$@"
}

case "${CERBERO_PROCESSO:-api}" in
  api)
    fermato=0
    node lib/db/scripts/migra.mjs &
    figlio=$!
    trap 'fermato=1; kill -TERM "$figlio" 2>/dev/null' TERM INT
    # wait torna presto se arriva un segnale: si aspetta finché node è vivo
    stato=0
    while :; do
      wait "$figlio"
      stato=$?
      kill -0 "$figlio" 2>/dev/null || break
    done
    trap - TERM INT
    if [ "$fermato" -eq 1 ]; then exit 143; fi
    if [ "$stato" -ne 0 ]; then exit "$stato"; fi
    # le credenziali del migratore non servono all'API né ai solver che lancia
    unset DATABASE_MIGRATOR_URL
    # in pg_stat_activity l'API si distingue dal lavoratore
    export PGAPPNAME="${PGAPPNAME:-cerbero-api}"
    come_node node artifacts/api-server/dist/index.cjs
    ;;
  lavoratore)
    # niente migrazioni: le applica l'API. Il lavoratore prende lavori solo
    # quando lo schema è quello che conosce (guardia di versione).
    unset DATABASE_MIGRATOR_URL
    export PGAPPNAME="${PGAPPNAME:-cerbero-lavoratore}"
    come_node node artifacts/api-server/dist/lavoratore.cjs
    ;;
  *)
    echo "CERBERO_PROCESSO=${CERBERO_PROCESSO}: valore sconosciuto (ammessi: api, lavoratore)" >&2
    exit 1
    ;;
esac
