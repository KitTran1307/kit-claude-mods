import { describe, expect, test } from 'claude-code/testing'

import { classifyBash, sqlDrop } from './risk'
import { ROOT, CTX, SENTINEL, table, quiet, del, db, push, timed } from '../tests/risk-helpers'
import type { Want } from '../tests/risk-helpers'

// The Bash classifier (risk.ts): database drops from psql, mysql, sqlite and friends, sqlDrop, and `wrangler d1 execute`.

// ---------------------------------------------------------------------------------------------------------------------
describe('databases', () => {
  describe('SQL given on the command line', () => {
    table([
      ['psql -c "DROP TABLE users"', [db('psql', 'users')]],
      ["psql -d shop -c 'drop table if exists users cascade'", [db('psql', 'users')]],
      ['psql --command="DROP DATABASE shop"', [db('psql', 'shop')]],
      ['psql -c "DROP SCHEMA public CASCADE"', [db('psql', 'public')]],
      ['psql -c "DROP TABLE public.users"', [db('psql', 'public.users')]],
      ['psql -c "TRUNCATE TABLE orders"', [db('psql', 'orders')]],
      ['psql -c "TRUNCATE orders, items"', [db('psql', 'orders')]],
      ['psql -c \'TRUNCATE "Orders"\'', [db('psql', 'Orders')]],
      ['psql -c "select 1; drop table t; select 2"', [db('psql', 't')]],
      ['/usr/bin/psql -c "DROP TABLE t"', [db('psql', 't')]],
      ['sudo -u postgres psql -c "DROP DATABASE shop"', [db('psql', 'shop')]],
      ['mysql -e "DROP DATABASE shop"', [db('mysql', 'shop')]],
      ["mysql -uroot -e 'drop table t'", [db('mysql', 't')]],
      ['mysql --execute="TRUNCATE t"', [db('mysql', 't')]],
      ["mysql -e 'DROP TABLE `t`'", [db('mysql', 't')]],
      ['mariadb -e "DROP TABLE t"', [db('mariadb', 't')]],
      ['sqlite3 app.db "DROP TABLE t"', [db('sqlite3', 't', ['app.db'])]],
      ["sqlite3 data/app.sqlite 'DROP TABLE IF EXISTS \"t\"'", [db('sqlite3', 't', ['data/app.sqlite'])]],
      ['sqlite3 -batch app.db "DROP TABLE t"', [db('sqlite3', 't', ['app.db'])]],
      ['sqlite3 app.db "SELECT 1; DROP TABLE t;"', [db('sqlite3', 't', ['app.db'])]],
      ['sqlite3 :memory: "DROP TABLE t"', [db('sqlite3', 't')]],
      ['sqlite3 "$DB" "DROP TABLE t"', [db('sqlite3', 't', [], true)]],
      ['cd data && sqlite3 app.db "DROP TABLE t"', [db('sqlite3', 't', [`${ROOT}/data/app.db`])]],
      ['mongosh --eval "db.dropDatabase()"', [db('mongosh')]],
      ["mongosh shop --eval 'db.users.drop()'", [db('mongosh', 'users')]],
      ['mongo --eval "db.dropDatabase()"', [db('mongo')]],
      ['redis-cli FLUSHALL', [db('redis-cli')]],
      ['redis-cli flushdb', [db('redis-cli')]],
      ['redis-cli -n 2 FLUSHDB', [db('redis-cli')]],
      ['redis-cli -h cache.example FLUSHALL ASYNC', [db('redis-cli')]],
    ])
  })
  describe('database command-line tools', () => {
    table([
      ['dropdb shop', [db('dropdb', 'shop')]],
      ['dropdb -h localhost -U postgres shop', [db('dropdb', 'shop')]],
      ['dropdb --if-exists shop', [db('dropdb', 'shop')]],
      ['dropdb "$DB"', [db('dropdb')]],
      ['mysqladmin drop shop', [db('mysqladmin drop', 'shop')]],
      ['mysqladmin -u root drop shop -f', [db('mysqladmin drop', 'shop')]],
      ['prisma migrate reset', [db('prisma migrate reset')]],
      ['npx prisma migrate reset --force', [db('prisma migrate reset')]],
      ['pnpm exec prisma migrate reset', [db('prisma migrate reset')]],
      ['yarn prisma migrate reset', [db('prisma migrate reset')]],
      ['bunx prisma migrate reset --skip-seed', [db('prisma migrate reset')]],
      ['prisma db push --force-reset', [db('prisma db push --force-reset')]],
      ['rails db:drop', [db('rails db:drop')]],
      ['rails db:reset', [db('rails db:reset')]],
      ['bin/rails db:drop', [db('rails db:drop')]],
      ['rake db:drop', [db('rake db:drop')]],
      ['bundle exec rake db:reset', [db('rake db:reset')]],
      ['RAILS_ENV=test rails db:drop', [db('rails db:drop')]],
      ['rails db:drop:all', [db('rails db:drop:all')]],
      ['rake db:migrate:reset', [db('rake db:migrate:reset')]],
      ['sequelize db:drop', [db('sequelize db:drop')]],
      ['npx sequelize-cli db:migrate:undo:all', [db('sequelize-cli db:migrate:undo:all')]],
      ['typeorm schema:drop', [db('typeorm schema:drop')]],
      ['npx typeorm schema:drop -d ds.ts', [db('typeorm schema:drop')]],
      ['typeorm-ts-node-commonjs schema:drop', [db('typeorm schema:drop')]],
      ['drizzle-kit drop', [db('drizzle-kit drop')]],
      ['npx drizzle-kit drop', [db('drizzle-kit drop')]],
      ['python manage.py flush', [db('manage.py flush')]],
      ['python3 manage.py flush --noinput', [db('manage.py flush')]],
      ['poetry run python manage.py flush', [db('manage.py flush')]],
      ['python -m django flush', [db('django flush')]],
      ['django-admin flush', [db('django-admin flush')]],
      ['./manage.py flush', [db('manage.py flush')]],
      ['python manage.py reset_db', [db('manage.py reset_db')]],
      ['supabase db reset', [db('supabase db reset')]],
      ['npx supabase db reset', [db('supabase db reset')]],
      ['knex migrate:rollback --all', [db('knex migrate:rollback --all')]],
      ['npx knex migrate:rollback --all', [db('knex migrate:rollback --all')]],
      ['php artisan migrate:fresh', [db('php artisan migrate:fresh')]],
      ['php artisan db:wipe', [db('php artisan db:wipe')]],
      ['sudo -u postgres dropdb shop', [db('dropdb', 'shop')]],
      ['bash -c "dropdb shop"', [db('dropdb', 'shop')]],
    ])
  })
  describe('not risky', () => {
    quiet([
      'psql -c "SELECT * FROM users"', 'psql -c "CREATE TABLE t(id int)"', 'psql -c "INSERT INTO t VALUES (1)"', "psql -c '\\dt'", 'psql -c "DROP VIEW v"',
      'psql -c "DROP INDEX i"', 'psql -c "ALTER TABLE t DROP COLUMN c"', 'psql -c "SELECT truncate(1.5)"', 'psql -c "SELECT truncate (1.5, 0)"', 'psql -c "SELECT \'dropped table\'"', 'psql -f drop_all.sql',
      'psql shop', 'psql', 'mysql -e "SELECT TRUNCATE(3.14159, 2)"', 'mysql -e "show tables"', 'mysql -u root', 'sqlite3 app.db ".tables"', 'sqlite3 app.db "SELECT 1"',
      'sqlite3 app.db', 'redis-cli GET key', 'redis-cli PING', 'redis-cli -a pass SET a b', 'mongosh --eval "db.users.find()"', 'dropdb', 'dropdb --help',
      'mysqladmin status', 'mysqladmin -u root ping', 'prisma migrate dev', 'prisma generate', 'prisma db push', 'prisma migrate deploy', 'prisma studio',
      'rails db:migrate', 'rails db:seed', 'rails server', 'rake db:setup', 'rake test', 'python manage.py migrate', 'python manage.py runserver', 'python script.py flush',
      './manage.py migrate', 'python manage.py shell', 'python -m pytest', 'python -m django migrate',
      'supabase db push', 'supabase start', 'knex migrate:latest', 'knex migrate:rollback', 'drizzle-kit generate', 'typeorm migration:run', 'sequelize db:migrate',
      'php artisan migrate', 'php artisan serve', 'echo "DROP TABLE x" | psql', 'echo "psql -c \'DROP TABLE x\'"', 'grep "DROP TABLE" schema.sql', 'cat drop.sql',
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('sqlDrop', () => {
  const rows: Array<[string, { name?: string } | null]> = [
    ['DROP TABLE users', { name: 'users' }],
    ['drop table if exists users cascade', { name: 'users' }],
    ['DROP DATABASE shop;', { name: 'shop' }],
    ['DROP SCHEMA IF EXISTS public CASCADE', { name: 'public' }],
    ['drop   table\n  t', { name: 't' }],
    ['DROP TABLE "My Table"', { name: 'My Table' }],
    ['DROP TABLE `t`', { name: 't' }],
    ['DROP TABLE [dbo].[t]', { name: 'dbo' }],
    ['TRUNCATE users', { name: 'users' }],
    ['truncate table users restart identity', { name: 'users' }],
    ['TRUNCATE TABLE ONLY users', { name: 'users' }],
    ['db.dropDatabase()', {}],
    ['db.users.drop()', { name: 'users' }],
    ['FLUSHALL', {}],
    ['flushdb', {}],
    ['DROP TABLE', {}],
    ['DROP VIEW v', null],
    ['DROP INDEX i', null],
    ['SELECT 1', null],
    ['SELECT truncate(1.5)', null],
    ['SELECT truncate (1.5, 0)', null],
    ['ALTER TABLE t DROP COLUMN c', null],
    ['CREATE TABLE drop_me (id int)', null],
    ['dropped table', null],
    ['', null],
    ['flush tables', null],
  ]
  for (const [sql, want] of rows) test(JSON.stringify(sql), () => expect(sqlDrop(sql)).toEqual(want))
  test('odd input', () => {
    expect(sqlDrop(undefined as unknown as string)).toBeNull()
    timed('many spaces', () => sqlDrop('drop table' + ' '.repeat(1 << 20)))
    timed('many drops', () => sqlDrop('drop '.repeat(1 << 18)))
    timed('many truncates', () => sqlDrop('truncate '.repeat(1 << 17)))
    timed('truncate and spaces', () => sqlDrop('truncate' + ' '.repeat(1 << 20) + '('))
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('wrangler d1 execute: SQL on the command line', () => {
  const W = 'wrangler d1 execute'
  const wr = (label: string, name?: string): Want => db(label, name)
  const D = 'wrangler d1 execute'
  describe('a drop, a truncate or DELETE FROM in --command', () => {
    table([
      [`${W} shop --command "DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} shop --command="DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} shop --command 'drop table if exists users;'`, [wr(D, 'users')]],
      [`${W} shop -c "DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} shop -c="DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} shop --sql "DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} shop --sql="DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} shop --remote --command "DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} shop --local --command "DROP TABLE users" --persist-to ./state`, [wr(D, 'users')]],
      [`${W} --remote shop --command "DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} --command "DROP TABLE users" shop --remote`, [wr(D, 'users')]],
      [`${W} shop --env prod --command "DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} shop --json --yes --command "DROP TABLE users"`, [wr(D, 'users')]],
      [`wrangler --config wrangler.toml d1 execute shop --command "DROP TABLE users"`, [wr(D, 'users')]],
      [`wrangler d1 --remote execute shop --command "DROP TABLE users"`, [wr(D, 'users')]],
      [`${W} shop --command "DROP DATABASE shop"`, [wr(D, 'shop')]],
      [`${W} shop --command "DROP SCHEMA IF EXISTS app CASCADE"`, [wr(D, 'app')]],
      [`${W} shop --command "DROP VIEW v"`, [wr(D, 'v')]],
      [`${W} shop --command "DROP INDEX idx_users_email"`, [wr(D, 'idx_users_email')]],
      [`${W} shop --command "DROP INDEX IF EXISTS i"`, [wr(D, 'i')]],
      [`${W} shop --command "TRUNCATE TABLE carts"`, [wr(D, 'carts')]],
      [`${W} shop --command "truncate carts"`, [wr(D, 'carts')]],
      [`${W} shop --command "DELETE FROM orders"`, [wr(D, 'orders')]],
      [`${W} shop --command "delete from orders where id = 5"`, [wr(D, 'orders')]],
      [`${W} shop --command "Delete   From   Orders;"`, [wr(D, 'Orders')]],
      [`${W} shop --command "DELETE FROM main.orders"`, [wr(D, 'main.orders')]],
      [`${W} shop --command 'DELETE FROM "order items"'`, [wr(D, 'order items')]],
      [`${W} shop --command 'DROP TABLE \`order items\`'`, [wr(D, 'order items')]],
      [`${W} shop --command 'DROP TABLE [dbo]'`, [wr(D, 'dbo')]],
      [`${W} shop --command "SELECT 1; DROP TABLE a"`, [wr(D, 'a')]],
      [`${W} shop --command "INSERT INTO t VALUES (1); DELETE FROM t"`, [wr(D, 't')]],
      [`${W} shop --command "DROP TABLE users; DROP TABLE orders"`, [wr(D, 'users')]],
      [`${W} shop --command "DELETE FROM a; DROP TABLE b"`, [wr(D, 'a')]],
      [`${W} shop --command "DROP TABLE b; DELETE FROM a"`, [wr(D, 'b')]],
      [`${W} shop --command "TRUNCATE x; DROP TABLE y"`, [wr(D, 'x')]],
      [`${W} shop --command "DROP TABLE a\nDROP TABLE b"`, [wr(D, 'a')]],
    ])
  })
  describe('every way to run wrangler', () => {
    const sql = '--command "DROP TABLE users"'
    table([
      [`npx wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`npx wrangler@latest d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`npx wrangler@3.78.0 d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`npx --yes wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`npx -y wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`npx --package wrangler wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`pnpm exec wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`pnpm wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`pnpm dlx wrangler@latest d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`yarn wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`yarn dlx wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`bunx wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`bunx wrangler@latest d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`bun x wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`bun wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`npm exec -- wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`npm exec wrangler -- d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`./node_modules/.bin/wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`node_modules/.bin/wrangler.cmd d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`sudo wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`env CF_ACCOUNT=1 wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`CF_ACCOUNT=1 wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`cd web && wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`bash -c "wrangler d1 execute shop --command 'DROP TABLE users'"`, [wr(D, 'users')]],
      [`wrangler d1 execute shop ${sql} && echo done`, [wr(D, 'users')]],
      [`echo y | wrangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`w\\rangler d1 execute shop ${sql}`, [wr(D, 'users')]],
      [`wrangler d1 execute shop --comm\\and "DROP TABLE users"`, [wr(D, 'users')]],
    ])
  })
  describe('the name: the table when readable, else the database argument', () => {
    table([
      [`${W} shop --command "DROP TABLE"`, [wr(D, 'shop')]],
      [`${W} shop --command "DELETE FROM"`, [wr(D, 'shop')]],
      [`${W} shop --command "TRUNCATE ;"`, [wr(D, 'shop')]],
      [`${W} shop --command "DROP TABLE $T"`, [wr(D, 'shop')]],
      [`${W} shop --command="DROP TABLE $T"`, [wr(D, 'shop')]],
      [`${W} --remote --command "DROP TABLE" shop`, [wr(D, 'shop')]],
      [`${W} --command "DROP TABLE" --env prod shop`, [wr(D, 'shop')]],
      [`${W} "$DB" --command "DROP TABLE"`, [wr(D)]],
      [`${W} --command "DROP TABLE"`, [wr(D)]],
      [`${W} 'my shop' --command "DROP TABLE"`, [wr(D, 'my shop')]],
      [`${W} ${'d'.repeat(100)} --command "DROP TABLE"`, [wr(D, 'd'.repeat(60))]],
      [`${W} 'a\u0001b' --command "DROP TABLE"`, [wr(D, 'ab')]],
      [`${W} shop --command "DROP TABLE ${'t'.repeat(100)}"`, [wr(D, 't'.repeat(60))]],
    ])
  })
  describe('not risky', () => {
    quiet([
      `${W} shop --file ./schema.sql`,
      `${W} shop --file=./drop.sql`,
      `${W} shop --file "DROP TABLE x.sql"`,
      `${W} shop --remote --file ./seed.sql`,
      `${W} shop --command "SELECT * FROM users"`,
      `${W} shop --command "SELECT count(*) FROM orders WHERE a = 1"`,
      `${W} shop --command "INSERT INTO t VALUES (1)"`,
      `${W} shop --command "CREATE TABLE t (id INTEGER PRIMARY KEY)"`,
      `${W} shop --command "CREATE TABLE c (id INT REFERENCES p(id) ON DELETE CASCADE)"`,
      `${W} shop --command "CREATE INDEX i ON t(a)"`,
      `${W} shop --command "UPDATE users SET a = 1"`,
      `${W} shop --command "ALTER TABLE t ADD COLUMN c TEXT"`,
      `${W} shop --command "ALTER TABLE t DROP COLUMN c"`,
      `${W} shop --command "PRAGMA table_list"`,
      `${W} shop --command "SELECT 'a drop of rain'"`,
      `${W} shop --command "SELECT truncate(1.5)"`,
      `${W} shop --command "SELECT 1" --file "DROP TABLE x.sql"`,
      `${W} shop --config "DROP TABLE x.toml" --command "SELECT 1"`,
      `${W} shop --command "$SQL"`,
      `${W} shop --command`,
      `${W} shop -c wrangler.toml --command "SELECT 1"`,
      `${W} shop`,
      `${W}`,
      'wrangler d1 list', 'wrangler d1 info shop', 'wrangler d1 create drop-table', 'wrangler d1 migrations apply shop', 'wrangler d1 migrations list shop', 'wrangler d1 export shop --output x.sql',
      'wrangler deploy', 'wrangler dev', 'wrangler kv key delete a', 'wrangler d1', 'wrangler execute d1', 'wrangler d1 executes shop --command "DROP TABLE t"',
      `echo ${W} shop --command "DROP TABLE t"`,
      `echo "wrangler d1 execute shop --command 'DROP TABLE t'"`,
      `npx prettier --command "DROP TABLE t"`,
      `mywrangler d1 execute shop --command "DROP TABLE t"`,
    ])
  })
  describe('SQL comments do not hide a statement', () => {
    table([
      [`${W} shop --command "DROP/**/TABLE t"`, [wr(D, 't')]],
      [`${W} shop --command "DROP /* gone */ TABLE t"`, [wr(D, 't')]],
      [`${W} shop --command "DROP -- gone\nTABLE t"`, [wr(D, 't')]],
      [`${W} shop --command "DELETE/**/FROM t"`, [wr(D, 't')]],
      [`${W} shop --command "DELETE -- all\nFROM t"`, [wr(D, 't')]],
      [`${W} shop --command "DROP/*a*//*b*/INDEX i"`, [wr(D, 'i')]],
      [`${W} shop --command "SELECT '/*'; DROP TABLE t; SELECT '*/'"`, [wr(D, 't')]],
      [`${W} shop --command "SELECT '--'; DROP TABLE t"`, [wr(D, 't')]],
      [`${W} shop --command "SELECT 1 -- x\n; DROP TABLE t"`, [wr(D, 't')]],
    ])
    quiet([
      `${W} shop --command "SELECT 1 /* nothing */"`,
      `${W} shop --command "SELECT 1 -- nothing"`,
      `${W} shop --command "DROP/**/COLUMN c"`,
    ])
  })
  describe('the other SQL tools keep their rules', () => {
    quiet([
      'psql -c "DELETE FROM users"', 'psql -c "DROP VIEW v"', 'psql -c "DROP INDEX i"', 'mysql -e "DELETE FROM t"', 'mysql -e "DROP VIEW v"', 'sqlite3 app.db "DELETE FROM t"',
      'sqlite3 app.db "DROP INDEX i"', 'redis-cli DEL k', 'mongosh --eval "db.t.deleteMany({})"',
    ])
    table([
      ['psql -c "DROP TABLE t"', [db('psql', 't')]],
      ['mysql -e "TRUNCATE t"', [db('mysql', 't')]],
      ['sqlite3 app.db "DROP TABLE t"', [db('sqlite3', 't', ['app.db'])]],
    ])
    test('sqlDrop is unchanged: no DELETE, no DROP VIEW / INDEX', () => {
      expect(sqlDrop('DELETE FROM users')).toBeNull()
      expect(sqlDrop('delete from users where id = 1')).toBeNull()
      expect(sqlDrop('DROP VIEW v')).toBeNull()
      expect(sqlDrop('DROP INDEX i')).toBeNull()
      expect(sqlDrop('DROP/**/TABLE t')).toBeNull()
      expect(sqlDrop('DROP TABLE t')).toEqual({ name: 't' })
    })
  })
  describe('several statements and several commands', () => {
    table([
      [`${W} a --command "DROP TABLE x"; ${W} b --command "DROP TABLE y"`, [wr(D, 'x'), wr(D, 'y')]],
      [`${W} a --command "DROP TABLE x"; ${W} a --command "DROP TABLE x"`, [wr(D, 'x')]],
      [`${W} a --command "DROP TABLE x" && git push -f && rm -rf build`, [wr(D, 'x'), push('git push -f'), del(['build'])]],
      [`${W} a --command "SELECT 1" --command "DROP TABLE x"`, [wr(D, 'x')]],
      [`${W} a --command "DROP TABLE x" --command "DROP TABLE y"`, [wr(D, 'x')]],
    ])
  })
  describe('label and hostile input', () => {
    test('the label is the fixed words: no database, no SQL, no token', () => {
      const T = SENTINEL
      const bad: string[] = []
      for (const cmd of [
        `${W} ${T}-db --command "DROP TABLE ${T}"`,
        `CLOUDFLARE_API_TOKEN=${T} wrangler d1 execute shop --command "DELETE FROM t WHERE k = '${T}'"`,
        `env CLOUDFLARE_API_TOKEN=${T} npx wrangler d1 execute ${T} --command "TRUNCATE ${T}"`,
        `${W} shop --command "DROP TABLE x" --account-id ${T}`,
      ]) {
        const got = classifyBash(cmd, CTX)
        if (got.length !== 1 || got[0]!.label !== 'wrangler d1 execute' || got[0]!.kind !== 'db-drop' || got[0]!.tier !== 'ask' || got[0]!.paths.length > 0) bad.push(`${cmd}: ${JSON.stringify(got)}`)
        if (got[0]?.remote !== undefined || got[0]?.source !== undefined || got[0]?.names !== undefined) bad.push(`${cmd}: extra fields`)
      }
      expect(bad).toEqual([])
    })
    test('odd forms never throw', () => {
      for (const cmd of ['wrangler', 'wrangler d1 execute --command', 'wrangler d1 execute -c', 'wrangler d1 execute --command=', 'wrangler d1 execute --command ""', 'wrangler d1 execute -c=',
        'wrangler d1 execute "" --command ""', 'wrangler d1 execute \u0000 --command "DROP TABLE \u0000"', 'wrangler@ d1 execute x --command "DROP TABLE t"', 'wrangler d1 d1 execute x -c "DROP TABLE t"']) {
        expect(Array.isArray(classifyBash(cmd, CTX)), cmd).toBe(true)
      }
    })
  })
})
