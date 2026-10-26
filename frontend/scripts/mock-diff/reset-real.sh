#!/bin/bash
# Возвращает данные настоящего бэкенда к дампу (real-data.dump), не останавливая бэкенд.
cd /c/Code/dvizh-mock
DC="docker compose -f docker-compose.dev.yml exec -T db"
TABLES=$($DC psql -U app -d app -At -c "select string_agg(quote_ident(tablename), ',') from pg_tables where schemaname='public' and tablename not in ('flyway_schema_history','spatial_ref_sys')")
$DC psql -U app -d app -q -c "TRUNCATE $TABLES CASCADE" > /dev/null
$DC pg_restore -U app -d app -a --disable-triggers < "$(dirname "$0")/real-data.dump" 2>&1 | grep -v "^$" | head -5
echo "reset ok"
