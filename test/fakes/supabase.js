// In-memory stand-in for @supabase/supabase-js, covering the PostgREST subset
// the bot actually uses. Enforces the same PK/unique constraints as schema-agent.sql
// so duplicate-key handling (23505) is exercised for real.

import crypto from 'node:crypto';

const TABLES = {
  meals: { pk: 'id', pkType: 'uuid', unique: [] },
  goals: { pk: 'chat_id', pkType: 'given', unique: [] },
  my_foods: { pk: 'id', pkType: 'serial', unique: [['chat_id', 'alias']] },
  measurements: { pk: 'id', pkType: 'serial', unique: [['chat_id', 'measured_on']] },
  agent_updates: { pk: 'update_id', pkType: 'given', unique: [] },
  agent_actions: { pk: 'id', pkType: 'serial', unique: [] },
  agent_chat_log: { pk: 'id', pkType: 'serial', unique: [] },
};

const store = new Map();
const seq = new Map();

export function __reset() {
  store.clear();
  seq.clear();
  for (const t of Object.keys(TABLES)) {
    store.set(t, []);
    seq.set(t, 1);
  }
}
__reset();

export const __db = {
  rows: (t) => store.get(t) || [],
  insert: (t, rows) => {
    for (const r of [].concat(rows)) store.get(t).push({ ...r });
  },
};

const dupErr = () => ({ code: '23505', message: 'duplicate key value violates unique constraint' });

function violates(table, row) {
  const meta = TABLES[table];
  const rows = store.get(table);
  if (row[meta.pk] !== undefined && rows.some((r) => r[meta.pk] === row[meta.pk])) return true;
  for (const cols of meta.unique) {
    if (cols.every((c) => row[c] !== undefined) &&
        rows.some((r) => cols.every((c) => r[c] === row[c]))) return true;
  }
  return false;
}

// Column defaults from schema-agent.sql — without these, `.eq('undone', false)`
// would never match a freshly inserted row.
const DEFAULTS = {
  meals: () => ({ ts: new Date().toISOString(), assumptions: '', confidence: 'medium', source: 'ai' }),
  goals: () => ({ calories: 2000, protein: 130, carbs: 200, fat: 65, updated_at: new Date().toISOString() }),
  my_foods: () => ({ updated_at: new Date().toISOString() }),
  measurements: () => ({}),
  agent_updates: () => ({ seen_at: new Date().toISOString() }),
  agent_actions: () => ({ undone: false, created_at: new Date().toISOString() }),
  agent_chat_log: () => ({ created_at: new Date().toISOString() }),
};

function withPk(table, row) {
  const meta = TABLES[table];
  const out = { ...DEFAULTS[table](), ...row };
  if (out[meta.pk] === undefined) {
    if (meta.pkType === 'uuid') out[meta.pk] = crypto.randomUUID();
    else if (meta.pkType === 'serial') {
      out[meta.pk] = seq.get(table);
      seq.set(table, out[meta.pk] + 1);
    }
  }
  return out;
}

const cmp = (a, b) => (a === b ? 0 : a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1);

class Query {
  constructor(table, op, payload, opts = {}) {
    this.table = table;
    this.op = op;
    this.payload = payload;
    this.opts = opts;
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.mode = 'many';
    this.wantSelect = op === 'select';
  }

  select() { this.wantSelect = true; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  lt(col, val) { this.filters.push((r) => r[col] < val); return this; }
  gte(col, val) { this.filters.push((r) => r[col] >= val); return this; }
  lte(col, val) { this.filters.push((r) => r[col] <= val); return this; }
  in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
  order(col, o = {}) { this.orders.push([col, o.ascending !== false]); return this; }
  limit(nn) { this.limitN = nn; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }

  match(rows) { return rows.filter((r) => this.filters.every((f) => f(r))); }

  shape(rows) {
    let out = rows.map((r) => ({ ...r }));
    for (const [col, asc] of [...this.orders].reverse()) {
      out.sort((a, b) => (asc ? cmp(a[col], b[col]) : cmp(b[col], a[col])));
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    if (this.mode === 'single') {
      if (out.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'expected single row' } };
      return { data: out[0], error: null };
    }
    if (this.mode === 'maybe') return { data: out[0] || null, error: null };
    return { data: out, error: null };
  }

  run() {
    const rows = store.get(this.table);
    if (!rows) return { data: null, error: { message: `no such table ${this.table}` } };

    if (this.op === 'select') return this.shape(this.match(rows));

    if (this.op === 'insert') {
      const incoming = [].concat(this.payload);
      const prepared = [];
      for (const r of incoming) {
        const row = withPk(this.table, r);
        if (violates(this.table, row)) return { data: null, error: dupErr() };
        prepared.push(row);
      }
      rows.push(...prepared);
      return this.wantSelect ? this.shape(prepared) : { data: null, error: null };
    }

    if (this.op === 'update') {
      const hits = this.match(rows);
      for (const r of hits) Object.assign(r, this.payload);
      return this.wantSelect ? this.shape(hits) : { data: null, error: null };
    }

    if (this.op === 'delete') {
      const hits = this.match(rows);
      for (const r of hits) rows.splice(rows.indexOf(r), 1);
      return this.wantSelect ? this.shape(hits) : { data: null, error: null };
    }

    if (this.op === 'upsert') {
      const cols = (this.opts.onConflict || '').split(',').map((s) => s.trim()).filter(Boolean);
      const incoming = [].concat(this.payload);
      const touched = [];
      for (const r of incoming) {
        const existing = cols.length
          ? rows.find((x) => cols.every((c) => x[c] === r[c]))
          : rows.find((x) => x[TABLES[this.table].pk] === r[TABLES[this.table].pk]);
        if (existing) {
          Object.assign(existing, r);
          touched.push(existing);
        } else {
          const row = withPk(this.table, r);
          rows.push(row);
          touched.push(row);
        }
      }
      return this.wantSelect ? this.shape(touched) : { data: null, error: null };
    }

    return { data: null, error: { message: `unsupported op ${this.op}` } };
  }

  then(resolve, reject) {
    try {
      resolve(this.run());
    } catch (err) {
      reject(err);
    }
  }
}

class Table {
  constructor(name) { this.name = name; }
  select() { return new Query(this.name, 'select'); }
  insert(payload) { return new Query(this.name, 'insert', payload); }
  update(payload) { return new Query(this.name, 'update', payload); }
  delete() { return new Query(this.name, 'delete'); }
  upsert(payload, opts) { return new Query(this.name, 'upsert', payload, opts); }
}

export function createClient() {
  return { from: (name) => new Table(name) };
}
