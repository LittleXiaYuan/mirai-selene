/** Agent 作业与会话的持久化：摄取/推演可回放，forge 会话可跨重启。 */

export function saveRun(db, { id, ownerKey, kind, title, input, output }) {
  try {
    db.prepare(
      'INSERT OR REPLACE INTO agent_runs (id, owner_key, kind, title, input_json, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      ownerKey,
      kind,
      String(title ?? '').slice(0, 80),
      JSON.stringify(input ?? {}),
      JSON.stringify(output ?? {}),
      new Date().toISOString(),
    );
  } catch {
    // 存不下不影响本次返回
  }
}

export function listRuns(db, ownerKey, limit = 12) {
  try {
    return db
      .prepare(
        'SELECT id, kind, title, created_at FROM agent_runs WHERE owner_key = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(ownerKey, Math.max(1, Math.min(50, Number(limit) || 12)))
      .map((row) => ({ id: row.id, kind: row.kind, title: row.title, created_at: row.created_at }));
  } catch {
    return [];
  }
}

export function getRun(db, id, ownerKey) {
  try {
    const row = db
      .prepare('SELECT * FROM agent_runs WHERE id = ? AND owner_key = ?')
      .get(id, ownerKey);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      created_at: row.created_at,
      input: JSON.parse(row.input_json),
      output: JSON.parse(row.output_json),
    };
  } catch {
    return null;
  }
}

/** 作业留 14 天，未完成的 forge 会话留 1 天（TTL 只有 30 分钟）。 */
export function pruneAgentData(db, { runDays = 14, forgeHours = 24 } = {}) {
  const cut = (ms) => new Date(Date.now() - ms).toISOString();
  try {
    const runs = db.prepare('DELETE FROM agent_runs WHERE created_at < ?').run(cut(runDays * 864e5));
    const forge = db.prepare('DELETE FROM forge_sessions WHERE updated_at < ?').run(cut(forgeHours * 36e5));
    return { runs: runs.changes, forge: forge.changes };
  } catch {
    return { runs: 0, forge: 0 };
  }
}

export function saveForgeSession(db, id, state) {
  try {
    db.prepare('INSERT OR REPLACE INTO forge_sessions (id, state_json, updated_at) VALUES (?, ?, ?)').run(
      id,
      JSON.stringify(state),
      new Date().toISOString(),
    );
  } catch {
    // 内存里仍然可用
  }
}

export function loadForgeSession(db, id) {
  try {
    const row = db.prepare('SELECT state_json FROM forge_sessions WHERE id = ?').get(id);
    return row ? JSON.parse(row.state_json) : null;
  } catch {
    return null;
  }
}

export function deleteForgeSession(db, id) {
  try {
    db.prepare('DELETE FROM forge_sessions WHERE id = ?').run(id);
  } catch {
    // ignore
  }
}
