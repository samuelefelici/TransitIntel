#!/bin/sh
# Avvio del container di Cerbero (Dockerfile.api).
# Prima le migrazioni, poi l'API. Se le migrazioni falliscono il container non
# parte (fail-closed): con l'healthcheck Coolify tiene in servizio quello
# vecchio. Il database non cambia, perché la transazione è annullata.
#
# tini manda i segnali solo a questo sh: durante le migrazioni li inoltriamo a
# node, così un arresto annulla la transazione invece di uccidere il migratore
# di colpo. Dopo, `exec` fa diventare l'API il figlio diretto di tini.
set -u
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
    exec node artifacts/api-server/dist/index.cjs
    ;;
  *)
    echo "CERBERO_PROCESSO=${CERBERO_PROCESSO}: valore sconosciuto (ammesso: api)" >&2
    exit 1
    ;;
esac
