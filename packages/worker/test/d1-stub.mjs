/**
 * A hand-written stand-in for a D1 database.
 *
 * Real SQLite is not reachable from a plain Node test run, so statements are
 * matched by a distinctive substring of their SQL. Everything the routes under
 * test read comes from `responses`; everything they write lands in `writes`,
 * which assertions then inspect. The rate_limits table is simulated for real
 * (delete/count/insert/min), because the limiter's windowing behaviour is
 * exactly the kind of thing a test should not fake.
 */
export function fakeD1(responses = {}) {
  const writes = [];
  const rateLimits = [];

  function match(sql) {
    for (const [needle, value] of Object.entries(responses)) {
      if (sql.includes(needle)) return typeof value === 'function' ? value : () => value;
    }
    return null;
  }

  function rateLimitSimulate(sql, params) {
    if (sql.startsWith('DELETE FROM rate_limits WHERE key = ? AND timestamp < ?')) {
      const [key, before] = params;
      for (let i = rateLimits.length - 1; i >= 0; i--) {
        if (rateLimits[i].key === key && Number(rateLimits[i].timestamp) < Number(before)) rateLimits.splice(i, 1);
      }
      return { count: undefined };
    }
    if (sql.startsWith('DELETE FROM rate_limits WHERE key = ?')) {
      const [key] = params;
      for (let i = rateLimits.length - 1; i >= 0; i--) if (rateLimits[i].key === key) rateLimits.splice(i, 1);
      return {};
    }
    if (sql.startsWith('INSERT INTO rate_limits')) {
      const [key, timestamp] = params;
      rateLimits.push({ key, timestamp });
      return {};
    }
    if (sql.includes('COUNT(*) as count FROM rate_limits')) {
      const [key, since] = params;
      const count = rateLimits.filter(row => row.key === key && Number(row.timestamp) >= Number(since)).length;
      return { first: { count } };
    }
    if (sql.includes('MIN(timestamp) as oldest FROM rate_limits')) {
      const [key, since] = params;
      const stamps = rateLimits.filter(row => row.key === key && Number(row.timestamp) >= Number(since)).map(row => Number(row.timestamp));
      return { first: { oldest: stamps.length ? Math.min(...stamps) : null } };
    }
    return null;
  }

  const db = {
    writes,
    rateLimits,
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) {
          params = values;
          return statement;
        },
        async all() {
          const simulated = rateLimitSimulate(sql, params);
          if (simulated) return { results: [] };
          const handler = match(sql);
          const value = handler ? handler(params) : [];
          const rows = Array.isArray(value) ? value : value?.results ?? (value ? [value] : []);
          return { results: rows };
        },
        async first() {
          const simulated = rateLimitSimulate(sql, params);
          if (simulated) return simulated.first ?? null;
          const handler = match(sql);
          const value = handler ? handler(params) : null;
          if (value === null || value === undefined) return null;
          if (Array.isArray(value)) return value[0] ?? null;
          if (value.results) return value.results[0] ?? null;
          return value;
        },
        async raw() {
          const handler = match(sql);
          return handler ? [handler(params)] : [];
        },
        async run() {
          rateLimitSimulate(sql, params);
          writes.push({ sql, params });
          return { success: true, meta: { changes: 1, last_row_id: writes.length } };
        },
        batch: undefined,
      };
      return statement;
    },
  };

  return db;
}

/** Every recorded write whose SQL contains the needle. */
export function writesMatching(db, needle) {
  return db.writes.filter(entry => entry.sql.includes(needle));
}

export function lastWrite(db, needle) {
  const matched = writesMatching(db, needle);
  return matched[matched.length - 1] ?? null;
}
