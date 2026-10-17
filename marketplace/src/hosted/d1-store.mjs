/** Durable D1 persistence. No runtime DDL or process-local authoritative state. */
export class StoreError extends Error {
  constructor(code, message, status = 503) { super(message); this.name = 'StoreError'; this.code = code; this.status = status; }
}

const keyFor = (kind, id) => JSON.stringify([kind, id]);
const copy = value => value === undefined ? undefined : structuredClone(value);
const MAX_RECORDS = 4000;
const MAX_WRITES = 40;

class Snapshot {
  constructor(rows) {
    this.records = new Map(rows.map(row => [keyFor(row.kind, row.id), { kind: row.kind, value: JSON.parse(row.body) }]));
    this.writes = new Map();
  }
  get(kind, id) { return copy(this.records.get(keyFor(kind, id))?.value ?? null); }
  count() { return this.records.size; }
  all(kind) { return [...this.records.values()].filter(record => record.kind === kind).map(record => copy(record.value)); }
  put(kind, value) {
    if (typeof kind !== 'string' || typeof value?.id !== 'string') throw new TypeError('Record kind and ID are required.');
    const key = keyFor(kind, value.id), record = { kind, value: copy(value) };
    this.records.set(key, record); this.writes.set(key, record);
    return copy(value);
  }
  remove(kind, id) { const key = keyFor(kind, id); this.records.delete(key); this.writes.set(key, { kind, id, remove: true }); }
}

export class D1Store {
  constructor(db, { maxRecords = MAX_RECORDS, maxRetries = 5 } = {}) {
    if (!db?.prepare || !db?.batch) throw new TypeError('A provisioned D1 binding is required.');
    this.db = db; this.maxRecords = maxRecords; this.maxRetries = maxRetries;
  }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }
  async initialize() {
    // This is application data initialization, not a schema migration.
    await this.statement("INSERT OR IGNORE INTO sona_revisions(id,revision) VALUES ('marketplace',0)").run();
  }
  async get(kind, id) {
    const row = await this.statement('SELECT body FROM sona_records WHERE kind=? AND id=?', kind, id).first();
    return row ? JSON.parse(row.body) : null;
  }
  async all(kind, { limit = this.maxRecords } = {}) {
    const count = Math.max(1, Math.min(this.maxRecords, Math.floor(limit)));
    const result = await this.statement('SELECT body FROM sona_records WHERE kind=? ORDER BY rowid DESC LIMIT ?', kind, count + 1).all();
    if (result.results.length > count) throw new StoreError('RESULT_CAPACITY', 'The requested record set exceeds this service limit.');
    return result.results.map(row => JSON.parse(row.body));
  }
  async put(kind, value) { return this.transaction(tx => tx.put(kind, value)); }
  async transaction(mutate) {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const [revisionResult, recordsResult] = await this.db.batch([
        this.statement("SELECT revision FROM sona_revisions WHERE id='marketplace'"),
        this.statement('SELECT kind,id,body FROM sona_records LIMIT ?', this.maxRecords + 1),
      ]);
      const revision = revisionResult.results[0]?.revision;
      if (!Number.isSafeInteger(revision)) throw new StoreError('STORE_UNINITIALIZED', 'The durable marketplace store has not been initialized.');
      if (recordsResult.results.length > this.maxRecords) throw new StoreError('STORE_CAPACITY', 'The marketplace storage capacity requires maintenance.');
      const snapshot = new Snapshot(recordsResult.results);
      const result = mutate(snapshot);
      if (result && typeof result.then === 'function') throw new TypeError('D1 transaction callbacks must be synchronous and contain no external effects.');
      if (!snapshot.writes.size) return result;
      if (snapshot.records.size > this.maxRecords || snapshot.writes.size > MAX_WRITES) throw new StoreError('STORE_CAPACITY', 'This mutation exceeds the bounded marketplace capacity.');
      const changes = [...snapshot.writes.values()].map(record => record.remove
        ? this.statement('DELETE FROM sona_records WHERE kind=? AND id=?', record.kind, record.id)
        : this.statement('INSERT INTO sona_records(kind,id,body) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body', record.kind, record.value.id, JSON.stringify(record.value)));
      try {
        // A stale revision deliberately violates NOT NULL. D1 rolls the entire
        // batch back; no partial listing/trade/receipt writes can be committed.
        await this.db.batch([
          this.statement("UPDATE sona_revisions SET revision=CASE WHEN revision=? THEN revision+1 ELSE NULL END WHERE id='marketplace'", revision),
          ...changes,
        ]);
        return result;
      } catch (error) {
        const detail = `${error?.message || ''} ${error?.cause?.message || ''}`;
        if (!/NOT NULL constraint failed: sona_revisions\.revision/i.test(detail)) throw error;
      }
    }
    throw new StoreError('STATE_BUSY', 'Marketplace state changed concurrently. Please retry.');
  }
  async createChallenge(challenge, now) {
    const result = await this.db.batch([
      this.statement('DELETE FROM sona_challenges WHERE expires<=?', now),
      this.statement('INSERT INTO sona_challenges(id,address,message,expires) SELECT ?,?,?,? WHERE (SELECT count(*) FROM sona_challenges)<10000', challenge.id, challenge.address, challenge.message, challenge.expires),
    ]);
    if (result[1].meta.changes !== 1) throw new StoreError('AUTH_CAPACITY', 'Authentication is busy. Retry shortly.', 429);
  }
  async challenge(id) { return this.statement('SELECT * FROM sona_challenges WHERE id=?', id).first(); }
  async consumeChallenge({ id, address, message, now, hash, expires }) {
    const result = await this.db.batch([
      this.statement('DELETE FROM sona_sessions WHERE expires<=?', now),
      this.statement('INSERT INTO sona_sessions(hash,address,expires) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM sona_challenges WHERE id=? AND address=? AND message=? AND expires>?) AND (SELECT count(*) FROM sona_sessions)<10000', hash, address, expires, id, address, message, now),
      this.statement('DELETE FROM sona_challenges WHERE id=? AND address=? AND message=? AND EXISTS (SELECT 1 FROM sona_sessions WHERE hash=?)', id, address, message, hash),
    ]);
    return result[1].meta.changes === 1 && result[2].meta.changes === 1;
  }
  async session(hash, now) { return this.statement('SELECT address FROM sona_sessions WHERE hash=? AND expires>?', hash, now).first(); }
  async logout(hash) { await this.statement('DELETE FROM sona_sessions WHERE hash=?', hash).run(); }
  async rateLimit(key, now, maximum = 120, period = 60000) {
    const window = Math.floor(now / period) * period;
    const result = await this.db.batch([
      this.statement('DELETE FROM sona_limits WHERE window<?', now - 120000),
      // The conditional update makes a denied request write zero counter rows,
      // including when many isolates concurrently reach the same limit.
      this.statement('INSERT INTO sona_limits(key,window,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN sona_limits.window=excluded.window THEN sona_limits.count+1 ELSE 1 END WHERE sona_limits.window<>excluded.window OR sona_limits.count<? RETURNING count', key, window, maximum),
    ]);
    return !!result[1].results[0] && result[1].results[0].count <= maximum;
  }
}
