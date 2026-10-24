// Per-user JSON persistence. One file per user under data/users/, written atomically.
// A record holds the user's preferences, calendar settings and manual events, day labels,
// accepted/declined proposals, feedback, and the last weather windows (for anti-oscillation).

import fs from 'node:fs';
import path from 'node:path';

const emptyRecord = (profile) => ({
  profile,
  calendar: { mode: 'manual', icsUrl: null, events: [], annotations: {}, dayLabels: {} },
  decisions: {},
  feedback: [],
  weatherWindows: [],
  updatedAt: null,
});

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.usersDir = path.join(dir, 'users');
    fs.mkdirSync(this.usersDir, { recursive: true });
    this.metaFile = path.join(dir, 'meta.json');
  }

  file(id) {
    if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error('invalid user id');
    return path.join(this.usersDir, `${id}.json`);
  }

  list() {
    return fs.readdirSync(this.usersDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.get(f.slice(0, -5)))
      .filter(Boolean)
      .map((r) => ({ id: r.profile.id, name: r.profile.name, sample: !!r.sample }));
  }

  get(id) {
    try {
      const rec = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
      return { ...emptyRecord(rec.profile), ...rec, calendar: { ...emptyRecord().calendar, ...rec.calendar } };
    } catch (e) {
      if (e.code === 'ENOENT' || e.message === 'invalid user id') return null;
      throw e;
    }
  }

  put(rec) {
    const file = this.file(rec.profile.id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...rec, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, file);
    return rec;
  }

  create(profile, extra = {}) {
    return this.put({ ...emptyRecord(profile), ...extra });
  }

  update(id, fn) {
    const rec = this.get(id);
    if (!rec) return null;
    const next = fn(rec) ?? rec;
    return this.put(next);
  }

  remove(id) {
    fs.rmSync(this.file(id), { force: true });
  }

  meta() {
    try {
      return JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
    } catch {
      return {};
    }
  }

  setMeta(patch) {
    fs.writeFileSync(this.metaFile, JSON.stringify({ ...this.meta(), ...patch }, null, 2));
  }
}
