import { createHmac, randomBytes } from 'node:crypto';

const codeLifetime = 120;
const sessionLifetime = 7 * 24 * 3600;

export function createPhoneLogin(db, key, gatewayToken, RequestError) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_challenges (
      id TEXT PRIMARY KEY, requester TEXT NOT NULL, account TEXT NOT NULL,
      gateway_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS phone_challenges_age ON phone_challenges(created_at);
    CREATE INDEX IF NOT EXISTS phone_challenges_account ON phone_challenges(account, created_at);
    CREATE TABLE IF NOT EXISTS phone_sessions (
      token_hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  const purge = db.prepare('DELETE FROM phone_challenges WHERE created_at < unixepoch() - 3600');
  const purgeSessions = db.prepare('DELETE FROM phone_sessions WHERE expires_at <= unixepoch()');
  const limits = db.prepare(`SELECT count(*) total,
    coalesce(sum(account = ?), 0) for_account,
    coalesce(sum(requester = ?), 0) for_requester,
    coalesce(sum(account = ? AND created_at >= unixepoch() - 60), 0) recent
    FROM phone_challenges WHERE created_at >= unixepoch() - 3600`);
  const reserve = db.prepare('INSERT INTO phone_challenges (id, requester, account) VALUES (?, ?, ?)');
  const attach = db.prepare('UPDATE phone_challenges SET gateway_id = ? WHERE id = ?');
  const tryCode = db.prepare(`UPDATE phone_challenges SET attempts = attempts + 1
    WHERE id = ? AND requester = ? AND gateway_id IS NOT NULL AND attempts < 5
      AND created_at >= unixepoch() - ${codeLifetime} RETURNING account, gateway_id`);
  const consume = db.prepare('UPDATE phone_challenges SET gateway_id = NULL WHERE id = ? AND gateway_id = ?');
  const recordSession = db.prepare(`INSERT INTO phone_sessions (token_hash, account, expires_at)
    VALUES (?, ?, unixepoch() + ${sessionLifetime})`);
  const session = db.prepare('SELECT account FROM phone_sessions WHERE token_hash = ? AND expires_at > unixepoch()');
  const revoke = db.prepare('DELETE FROM phone_sessions WHERE token_hash = ?');
  const digest = (scope, value) => createHmac('sha256', key).update(scope + ':' + value).digest('hex');

  async function call(method, payload) {
    if (!gatewayToken) throw new RequestError(503, 'phone_disabled');
    try {
      const response = await fetch('https://gatewayapi.telegram.org/' + method, {
        method: 'POST', headers: { Authorization: 'Bearer ' + gatewayToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json();
      if (response.ok && body.ok && body.result) return body.result;
    } catch { /* Gateway response details can include personal data. */ }
    throw new RequestError(502, 'phone_gateway');
  }

  function tokenHash(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) throw new RequestError(401, 'phone_session');
    return digest('session', token);
  }

  return {
    async start(requester, { phone }) {
      if (!gatewayToken) throw new RequestError(503, 'phone_disabled');
      if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new RequestError(422, 'phone_number');
      const account = 'phone:' + digest('number', phone);
      const challenge = randomBytes(24).toString('hex');
      purge.run();
      const counts = limits.get(account, requester, account);
      if (counts.for_account >= 3 || counts.for_requester >= 5 || counts.total >= 30 || counts.recent) {
        throw new RequestError(429, 'phone_limit');
      }
      reserve.run(challenge, requester, account);
      const result = await call('sendVerificationMessage', { phone_number: phone, code_length: 6, ttl: codeLifetime });
      if (typeof result.request_id !== 'string' || !result.request_id) throw new RequestError(502, 'phone_gateway');
      attach.run(result.request_id, challenge);
      return { challenge };
    },

    async verify(requester, { challenge, code }) {
      if (typeof challenge !== 'string' || !/^[a-f0-9]{48}$/.test(challenge) ||
          typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new RequestError(422, 'phone_code');
      const record = tryCode.get(challenge, requester);
      if (!record) throw new RequestError(422, 'phone_expired');
      const result = await call('checkVerificationStatus', { request_id: record.gateway_id, code });
      if (result.verification_status?.status !== 'code_valid') throw new RequestError(422, 'phone_code');
      if (!consume.run(challenge, record.gateway_id).changes) throw new RequestError(422, 'phone_expired');
      const token = randomBytes(32).toString('hex');
      purgeSessions.run();
      recordSession.run(tokenHash(token), record.account);
      return { token };
    },

    customer(token) {
      if (!gatewayToken) throw new RequestError(503, 'phone_disabled');
      const record = session.get(tokenHash(token));
      if (!record) throw new RequestError(401, 'phone_session');
      return record.account;
    },

    logout(token) {
      revoke.run(tokenHash(token));
    },
  };
}
