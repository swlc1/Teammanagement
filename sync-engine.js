/* Record-level optimistic sync. Shared by the browser and node:test. */
(function (root) {
  'use strict';
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  class RecordSync {
    constructor(commit, changed = () => {}) {
      this.commit = commit;
      this.changed = changed;
      this.server = new Map();
      this.pending = new Map();
      this.running = null;
      this.error = null;
      this.closed = false;
    }
    receive(key, record) {
      if (record) this.server.set(key, copy(record));
      else this.server.delete(key);
      this.changed();
    }
    view() {
      const result = new Map([...this.server].map(([key, record]) => [key, copy(record.value)]));
      for (const [key, edit] of this.pending) {
        if (edit.value === null) result.delete(key);
        else result.set(key, copy(edit.value));
      }
      return result;
    }
    stage(next) {
      if (this.closed) throw new Error('SYNC_CLOSED');
      const previous = this.view();
      for (const key of new Set([...previous.keys(), ...next.keys()])) {
        const value = next.has(key) ? next.get(key) : null;
        if (equal(previous.get(key) ?? null, value)) continue;
        const old = this.pending.get(key);
        this.pending.set(key, {
          base: old ? old.base : (this.server.get(key)?.version ?? null),
          value: copy(value)
        });
      }
      this.changed();
    }
    flush() {
      if (this.running) return this.running;
      this.running = this.drain().finally(() => { this.running = null; this.changed(); });
      return this.running;
    }
    async drain() {
      this.error = null;
      try {
        while (this.pending.size && !this.closed) {
          const [key, edit] = this.pending.entries().next().value;
          const version = await this.commit(key, copy(edit.value), edit.base);
          if (this.closed) return;
          if (edit.value === null) this.server.delete(key);
          else this.server.set(key, {version, value: copy(edit.value)});
          if (this.pending.get(key) === edit) this.pending.delete(key);
          else this.pending.get(key).base = version;
          this.changed();
        }
      } catch (error) {
        this.error = error;
        this.changed();
        throw error;
      }
    }
    discard() {
      if (this.running) throw new Error('SYNC_BUSY');
      this.pending.clear(); this.error = null; this.changed();
    }
    close() { this.closed = true; }
  }
  root.TmdRecordSync = RecordSync;
  if (typeof module !== 'undefined') module.exports = RecordSync;
})(typeof globalThis === 'undefined' ? window : globalThis);
