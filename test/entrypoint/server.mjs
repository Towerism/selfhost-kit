// The fixture image's stand-in for an app server (test/entrypoint/Dockerfile). Like an app, it keeps a
// SQLite database in WAL mode at NUXT_DATABASE_PATH and a generated secret under secrets/ beside it, so
// the container tests can check ownership, modes, replication and that secrets never reach the replica.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.env.NUXT_DATABASE_PATH ?? '/data/app.db';
const dataDir = dirname(dbPath);

const secrets = join(dataDir, 'secrets');
mkdirSync(secrets, { recursive: true, mode: 0o700 });
const secretFile = join(secrets, 'fixture-secret');
if (!existsSync(secretFile)) {
  writeFileSync(secretFile, `${randomBytes(24).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
}
// Default mode (0666), so its actual mode shows the umask the process runs with.
writeFileSync(join(dataDir, 'umask-probe'), 'probe\n');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
const insert = db.prepare('INSERT INTO rows (body) VALUES (?)');
const select = db.prepare('SELECT body FROM rows ORDER BY id');

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function send(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
  res.end(text);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, 'ok');
  if (req.method === 'GET' && req.url === '/argv') return send(res, 200, process.argv.slice(2));
  if (req.method === 'GET' && req.url === '/rows') {
    return send(
      res,
      200,
      select.all().map((row) => row.body),
    );
  }
  if (req.method === 'POST' && req.url === '/rows') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      insert.run(body);
      send(res, 201, 'created');
    });
    return;
  }
  send(res, 404, 'not found');
});

server.listen(3000, '0.0.0.0', () => console.log('[fixture] listening on 3000'));

process.on('SIGTERM', () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
});
