const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const ADMIN_FACE_CHALLENGE_TTL_MS = 1000 * 60 * 5;
const FACE_MATCH_DISTANCE_THRESHOLD = Number(process.env.FACE_MATCH_DISTANCE_THRESHOLD || 0.60);
const FACE_MATCH_MARGIN = Number(process.env.FACE_MATCH_MARGIN || 0.10);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashWithSalt(value, salt) {
  return crypto.pbkdf2Sync(value, salt, 100000, 64, 'sha512').toString('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateApiKey(prefix = 'face') {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

function normalizeScopes(input) {
  if (!input) return [];

  if (Array.isArray(input)) {
    return input.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(input)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseApiKeyFromRequest(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('ApiKey ')) {
    return authorization.replace(/^ApiKey\s+/i, '').trim();
  }

  return (req.headers['x-api-key'] || '').toString().trim();
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

const databaseSchemaSql = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    company VARCHAR(150),
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_api_keys (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    key_salt VARCHAR(64) NOT NULL,
    key_hash VARCHAR(128) NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT ARRAY['face:register','face:identify'],
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    full_name VARCHAR(150) NOT NULL,
    password_salt VARCHAR(64) NOT NULL,
    password_hash VARCHAR(128) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

  CREATE TABLE IF NOT EXISTS admin_sessions (
    id BIGSERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    device_id VARCHAR(128),
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id
  ON admin_sessions (admin_id);

  CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

  ALTER TABLE admin_sessions
    ADD COLUMN IF NOT EXISTS device_id VARCHAR(128);

  CREATE TABLE IF NOT EXISTS admin_face_embeddings (
    admin_id INTEGER PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
    embedding vector(128) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS admin_devices (
    id BIGSERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    device_id VARCHAR(128) NOT NULL,
    trusted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (admin_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS admin_face_challenges (
    id BIGSERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    device_id VARCHAR(128) NOT NULL,
    challenge_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE admin_face_challenges
    ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending';

  ALTER TABLE admin_face_challenges
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    client_id INTEGER,
    client_key_id INTEGER,
    action VARCHAR(100) NOT NULL,
    details JSONB DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rostros_usuarios (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER,
    usuario_id INTEGER NOT NULL,
    embedding vector(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

  ALTER TABLE rostros_usuarios
    ADD COLUMN IF NOT EXISTS cliente_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_rostros_usuarios_embedding_hnsw
ON rostros_usuarios
USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_rostros_usuarios_embedding_l2_hnsw
ON rostros_usuarios
USING hnsw (embedding vector_l2_ops);

CREATE INDEX IF NOT EXISTS idx_client_api_keys_client_id
ON client_api_keys (client_id);

CREATE INDEX IF NOT EXISTS idx_client_api_keys_status
ON client_api_keys (status);

CREATE INDEX IF NOT EXISTS idx_audit_logs_client_id
ON audit_logs (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
ON audit_logs (action, created_at DESC);
`;

async function initializeDatabase() {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.warn('PostgreSQL no está disponible en este momento.');
    console.warn('Inicia PostgreSQL y ejecuta schema.sql antes de usar la API de clientes.');
    console.warn('Error de conexión:', error.message);
    return false;
  }

  try {
    await pool.query(databaseSchemaSql);
    console.log('Esquema de base de datos verificado correctamente.');
    return true;
  } catch (error) {
    console.warn('No se pudo crear automáticamente el esquema de base de datos.');
    console.warn('Ejecuta schema.sql manualmente en PostgreSQL.');
    console.warn(error.message);
    return false;
  }
}

async function logAudit({ clientId = null, clientKeyId = null, action, details = {}, req }) {
  try {
    await pool.query(
      `
        INSERT INTO audit_logs (client_id, client_key_id, action, details, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        clientId,
        clientKeyId,
        action,
        JSON.stringify(details || {}),
        getClientIp(req),
        req.headers['user-agent'] || 'unknown'
      ]
    );
  } catch (error) {
    console.error('No se pudo registrar el audit log:', error.message);
  }
}

async function ensureSeedAdmin() {
  const connected = await initializeDatabase();
  if (!connected) {
    return;
  }

  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.warn('No se creó un administrador inicial: define ADMIN_EMAIL y ADMIN_PASSWORD en .env.');
    return;
  }

  try {
    const existing = await pool.query('SELECT id FROM admin_users WHERE email = $1', [adminEmail]);
    if (existing.rowCount > 0) {
      return;
    }

    const salt = generateSalt();
    const passwordHash = hashWithSalt(adminPassword, salt);

    await pool.query(
      `
        INSERT INTO admin_users (email, full_name, password_salt, password_hash, status)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [adminEmail, process.env.ADMIN_NAME || 'Administrador', salt, passwordHash, 'active']
    );

    console.warn('Administrador inicial creado:');
    console.warn(`Email: ${adminEmail}`);
    console.warn(`Contraseña: ${adminPassword}`);
  } catch (error) {
    console.warn('No se pudo crear el usuario administrador inicial.');
    console.warn('Verifica que la base de datos esté creada con schema.sql');
    console.warn(error.message);
  }
}

async function createAdminSession(adminUser, deviceId = null) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString();

  await pool.query(
    `INSERT INTO admin_sessions (admin_id, device_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [adminUser.id, deviceId, hashToken(token), expiresAt]
  );

  return { token, expiresAt };
}

async function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Token de administrador requerido.' });
  }

  try {
    const result = await pool.query(
      `
        SELECT s.id AS session_id, s.admin_id, s.device_id, s.expires_at, a.email, a.full_name
        FROM admin_sessions s
        INNER JOIN admin_users a ON a.id = s.admin_id
        WHERE s.token_hash = $1 AND a.status = 'active'
      `,
      [hashToken(token)]
    );

    const session = result.rows[0];
    if (!session) {
      return res.status(401).json({ ok: false, error: 'Sesión administrativa inválida o expirada.' });
    }

    if (Date.now() > new Date(session.expires_at).getTime()) {
      await pool.query('DELETE FROM admin_sessions WHERE id = $1', [session.session_id]);
      return res.status(401).json({ ok: false, error: 'Sesión administrativa expirada.' });
    }

    req.admin = {
      token,
      sessionId: session.session_id,
      adminId: session.admin_id,
      deviceId: session.device_id,
      email: session.email,
      fullName: session.full_name,
      expiresAt: session.expires_at
    };
    return next();
  } catch (error) {
    console.error('Error validando sesión administrativa:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo validar la sesión administrativa.' });
  }
}

async function requireClientApiKey(req, res, next) {
  const rawKey = parseApiKeyFromRequest(req);

  if (!rawKey) {
    return res.status(401).json({ ok: false, error: 'Falta la API key del cliente.' });
  }

  try {
    const keysResult = await pool.query(
      `
        SELECT k.*, c.name AS client_name, c.email AS client_email, c.status AS client_status
        FROM client_api_keys k
        INNER JOIN clients c ON c.id = k.client_id
        WHERE k.status = 'active' AND c.status = 'active'
      `
    );

    let matchedKey = null;

    for (const keyRow of keysResult.rows) {
      const candidateHash = hashWithSalt(rawKey, keyRow.key_salt);
      const candidateBuffer = Buffer.from(candidateHash, 'hex');
      const storedBuffer = Buffer.from(keyRow.key_hash, 'hex');

      if (candidateBuffer.length !== storedBuffer.length) {
        continue;
      }

      const isValid = crypto.timingSafeEqual(candidateBuffer, storedBuffer);
      if (isValid) {
        const expiresAt = keyRow.expires_at ? new Date(keyRow.expires_at).getTime() : null;
        if (expiresAt && Date.now() > expiresAt) {
          return res.status(401).json({ ok: false, error: 'La API key del cliente ha expirado.' });
        }

        matchedKey = keyRow;
        break;
      }
    }

    if (!matchedKey) {
      return res.status(401).json({ ok: false, error: 'API key inválida o no autorizada.' });
    }

    const requiredScope = req.route && req.route.path && req.route.path.includes('registrar')
      ? 'face:register'
      : req.route && req.route.path && req.route.path.includes('identificar')
        ? 'face:identify'
        : null;

    if (requiredScope && !(matchedKey.scopes || []).includes(requiredScope)) {
      return res.status(403).json({ ok: false, error: 'La API key no tiene permisos para esta operación.' });
    }

    await pool.query(
      `UPDATE client_api_keys SET last_used_at = NOW() WHERE id = $1`,
      [matchedKey.id]
    );

    req.client = {
      id: matchedKey.client_id,
      client_name: matchedKey.client_name,
      client_email: matchedKey.client_email
    };
    req.apiKey = matchedKey;
    next();
  } catch (error) {
    console.error('Error validando API key:', error);
    return res.status(500).json({ ok: false, error: 'Error interno al validar la API key.' });
  }
}

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT 1');
    res.json({
      ok: true,
      db: result.rowCount !== null,
      faceMatchDistanceThreshold: FACE_MATCH_DISTANCE_THRESHOLD,
      faceMatchMargin: FACE_MATCH_MARGIN
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin_console.html'));
});

app.post('/admin/login', async (req, res) => {
  const { email, password, deviceId } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Email y contraseña requeridos.' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM admin_users WHERE email = $1 AND status = 'active'`,
      [normalizeEmail(email)]
    );

    const adminUser = result.rows[0];
    if (!adminUser) {
      return res.status(401).json({ ok: false, error: 'Credenciales inválidas.' });
    }

    const hash = hashWithSalt(password, adminUser.password_salt);
    const storedHash = adminUser.password_hash;
    const storedBuffer = Buffer.from(storedHash, 'hex');
    const candidateBuffer = Buffer.from(hash, 'hex');

    if (storedBuffer.length !== candidateBuffer.length || !crypto.timingSafeEqual(storedBuffer, candidateBuffer)) {
      return res.status(401).json({ ok: false, error: 'Credenciales inválidas.' });
    }

    if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 128) {
      return res.status(400).json({ ok: false, error: 'No se pudo identificar este dispositivo.' });
    }

    const faceEnrollment = await pool.query(
      `SELECT 1 FROM admin_face_embeddings WHERE admin_id = $1`,
      [adminUser.id]
    );

    if (faceEnrollment.rowCount === 0) {
      await pool.query(
        `
          INSERT INTO admin_devices (admin_id, device_id)
          VALUES ($1, $2)
          ON CONFLICT (admin_id, device_id) DO UPDATE SET trusted_at = NOW()
        `,
        [adminUser.id, deviceId]
      );

      const { token, expiresAt } = await createAdminSession(adminUser, deviceId);
      return res.json({
        ok: true,
        token,
        expiresAt,
        faceSetupRequired: true,
        user: { id: adminUser.id, email: adminUser.email, fullName: adminUser.full_name }
      });
    }

    const trustedDevice = await pool.query(
      `SELECT id FROM admin_devices WHERE admin_id = $1 AND device_id = $2`,
      [adminUser.id, deviceId]
    );

    if (trustedDevice.rowCount === 0) {
      const challenge = generateToken();
      const challengeExpiresAt = new Date(Date.now() + ADMIN_FACE_CHALLENGE_TTL_MS).toISOString();
      const challengeResult = await pool.query(
        `
          INSERT INTO admin_face_challenges (admin_id, device_id, challenge_hash, expires_at)
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `,
        [adminUser.id, deviceId, hashToken(challenge), challengeExpiresAt]
      );

      return res.json({
        ok: true,
        requiresFace: true,
        challenge,
        approvalId: challengeResult.rows[0].id,
        challengeExpiresAt,
        user: { id: adminUser.id, email: adminUser.email, fullName: adminUser.full_name }
      });
    }

    const { token, expiresAt } = await createAdminSession(adminUser, deviceId);

    return res.json({
      ok: true,
      token,
      expiresAt,
      user: {
        id: adminUser.id,
        email: adminUser.email,
        fullName: adminUser.full_name
      }
    });
  } catch (error) {
    console.error('Error en login admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo iniciar sesión.' });
  }
});

app.post('/admin/logout', requireAdminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM admin_sessions WHERE id = $1', [req.admin.sessionId]);
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error cerrando sesión admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo cerrar la sesión.' });
  }
});

function normalizeFaceEmbedding(input) {
  if (!Array.isArray(input) || input.length !== 128) {
    return null;
  }

  const embedding = input.map(Number);
  return embedding.every(Number.isFinite) ? embedding : null;
}

app.post('/admin/face/enroll', requireAdminAuth, async (req, res) => {
  const embedding = normalizeFaceEmbedding(req.body?.embedding);

  if (!embedding) {
    return res.status(400).json({ ok: false, error: 'El rostro debe contener un embedding válido de 128 valores.' });
  }

  try {
    await pool.query(
      `
        INSERT INTO admin_face_embeddings (admin_id, embedding, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (admin_id) DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = NOW()
      `,
      [req.admin.adminId, `[${embedding.join(',')}]`]
    );

    await logAudit({ action: 'admin_face_enrolled', details: { adminId: req.admin.adminId }, req });
    return res.json({ ok: true, message: 'Rostro administrativo registrado correctamente.' });
  } catch (error) {
    console.error('Error registrando rostro admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo registrar el rostro.' });
  }
});

app.get('/admin/face/status', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT updated_at FROM admin_face_embeddings WHERE admin_id = $1`,
      [req.admin.adminId]
    );

    return res.json({
      ok: true,
      enrolled: result.rowCount > 0,
      updatedAt: result.rows[0]?.updated_at || null
    });
  } catch (error) {
    console.error('Error consultando estado biométrico:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo consultar el estado biométrico.' });
  }
});

app.delete('/admin/face/enroll', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM admin_face_embeddings WHERE admin_id = $1 RETURNING admin_id`,
      [req.admin.adminId]
    );
    await pool.query('DELETE FROM admin_devices WHERE admin_id = $1', [req.admin.adminId]);

    await logAudit({ action: 'admin_face_deleted', details: { adminId: req.admin.adminId }, req });
    return res.json({ ok: true, deleted: result.rowCount > 0 });
  } catch (error) {
    console.error('Error eliminando datos biométricos:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron eliminar los datos biométricos.' });
  }
});

app.post('/admin/face/login', async (req, res) => {
  const challenge = String(req.body?.challenge || '');
  const embedding = normalizeFaceEmbedding(req.body?.embedding);

  if (!challenge || !embedding) {
    return res.status(400).json({ ok: false, error: 'Reto y rostro válido son obligatorios.' });
  }

  try {
    const result = await pool.query(
      `
        SELECT a.id, a.email, a.full_name, c.device_id, c.expires_at AS challenge_expires_at,
               f.embedding <-> $2::vector AS distance
        FROM admin_face_challenges c
        INNER JOIN admin_users a ON a.id = c.admin_id
        INNER JOIN admin_face_embeddings f ON f.admin_id = a.id
        WHERE c.challenge_hash = $1 AND c.approval_status = 'pending' AND a.status = 'active'
        LIMIT 1
      `,
      [hashToken(challenge), `[${embedding.join(',')}]`]
    );

    const adminUser = result.rows[0];
    if (adminUser && Date.now() > new Date(adminUser.challenge_expires_at).getTime()) {
      await pool.query('DELETE FROM admin_face_challenges WHERE challenge_hash = $1', [hashToken(challenge)]);
      return res.status(401).json({ ok: false, error: 'El reto facial expiró. Inicia sesión nuevamente.' });
    }

    const distance = adminUser ? Number(adminUser.distance) : null;
    const verified = Boolean(adminUser && distance !== null && distance < FACE_MATCH_DISTANCE_THRESHOLD);

    await logAudit({
      action: 'admin_face_login_attempt',
      details: {
        verified,
        adminId: adminUser?.id || null,
        distance,
        threshold: FACE_MATCH_DISTANCE_THRESHOLD
      },
      req
    });

    if (!verified) {
      return res.status(401).json({ ok: false, error: 'No se pudo verificar el rostro.' });
    }

    await pool.query(
      `
        INSERT INTO admin_devices (admin_id, device_id)
        VALUES ($1, $2)
        ON CONFLICT (admin_id, device_id) DO UPDATE SET trusted_at = NOW()
      `,
      [adminUser.id, adminUser.device_id]
    );
    await pool.query('DELETE FROM admin_face_challenges WHERE challenge_hash = $1', [hashToken(challenge)]);

    const { token, expiresAt } = await createAdminSession(adminUser, adminUser.device_id);
    return res.json({
      ok: true,
      token,
      expiresAt,
      user: { id: adminUser.id, email: adminUser.email, fullName: adminUser.full_name }
    });
  } catch (error) {
    console.error('Error en login facial admin:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo iniciar sesión con el rostro.' });
  }
});

app.get('/admin/device-approvals', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT c.id, c.device_id, c.created_at, c.expires_at, a.email, a.full_name
        FROM admin_face_challenges c
        INNER JOIN admin_users a ON a.id = c.admin_id
        WHERE c.admin_id = $1
          AND c.approval_status = 'pending'
          AND c.expires_at > NOW()
          AND c.device_id <> COALESCE($2, '')
        ORDER BY c.created_at DESC
      `,
      [req.admin.adminId, req.admin.deviceId]
    );

    return res.json({ ok: true, requests: result.rows });
  } catch (error) {
    console.error('Error listando aprobaciones de dispositivos:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar las solicitudes.' });
  }
});

app.post('/admin/device-approvals/:id/approve', requireAdminAuth, async (req, res) => {
  const approvalId = Number(req.params.id);

  if (!approvalId) {
    return res.status(400).json({ ok: false, error: 'Solicitud de aprobación inválida.' });
  }

  try {
    const result = await pool.query(
      `
        UPDATE admin_face_challenges
        SET approval_status = 'approved', approved_at = NOW()
        WHERE id = $1 AND admin_id = $2 AND approval_status = 'pending'
          AND expires_at > NOW() AND device_id <> COALESCE($3, '')
        RETURNING id
      `,
      [approvalId, req.admin.adminId, req.admin.deviceId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'La solicitud ya expiró o fue procesada.' });
    }

    await logAudit({ action: 'admin_device_approved', details: { approvalId }, req });
    return res.json({ ok: true, message: 'Dispositivo aprobado.' });
  } catch (error) {
    console.error('Error aprobando dispositivo:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo aprobar el dispositivo.' });
  }
});

app.get('/admin/device-approvals/status', async (req, res) => {
  const approvalToken = String(req.query.token || '');

  if (!approvalToken) {
    return res.status(400).json({ ok: false, error: 'Token de aprobación requerido.' });
  }

  try {
    const result = await pool.query(
      `
        SELECT c.id, c.admin_id, c.device_id, c.approval_status, c.expires_at,
               a.email, a.full_name
        FROM admin_face_challenges c
        INNER JOIN admin_users a ON a.id = c.admin_id
        WHERE c.challenge_hash = $1 AND a.status = 'active'
      `,
      [hashToken(approvalToken)]
    );

    const request = result.rows[0];
    if (!request) {
      return res.status(404).json({ ok: false, error: 'Solicitud no encontrada.' });
    }

    if (Date.now() > new Date(request.expires_at).getTime()) {
      await pool.query('DELETE FROM admin_face_challenges WHERE id = $1', [request.id]);
      return res.status(410).json({ ok: false, error: 'La solicitud de aprobación expiró.' });
    }

    if (request.approval_status !== 'approved') {
      return res.json({ ok: true, approved: false });
    }

    const consumed = await pool.query(
      `UPDATE admin_face_challenges SET approval_status = 'consumed' WHERE id = $1 AND approval_status = 'approved' RETURNING id`,
      [request.id]
    );

    if (consumed.rowCount === 0) {
      return res.status(409).json({ ok: false, error: 'La aprobación ya fue utilizada.' });
    }

    await pool.query(
      `
        INSERT INTO admin_devices (admin_id, device_id)
        VALUES ($1, $2)
        ON CONFLICT (admin_id, device_id) DO UPDATE SET trusted_at = NOW()
      `,
      [request.admin_id, request.device_id]
    );

    const { token, expiresAt } = await createAdminSession(
      { id: request.admin_id },
      request.device_id
    );

    return res.json({
      ok: true,
      approved: true,
      token,
      expiresAt,
      user: { id: request.admin_id, email: request.email, fullName: request.full_name }
    });
  } catch (error) {
    console.error('Error consultando aprobación:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo consultar la aprobación.' });
  }
});

app.get('/admin/users', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, status, created_at FROM admin_users ORDER BY created_at DESC`
    );

    return res.json({ ok: true, admins: result.rows });
  } catch (error) {
    console.error('Error listando administradores:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar los administradores.' });
  }
});

app.post('/admin/users', requireAdminAuth, async (req, res) => {
  const { email, fullName, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !fullName || !password) {
    return res.status(400).json({ ok: false, error: 'Email, nombre y contraseña son obligatorios.' });
  }

  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return res.status(400).json({ ok: false, error: 'Introduce un correo electrónico válido.' });
  }

  if (String(password).length < 8) {
    return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' });
  }

  try {
    const salt = generateSalt();
    const passwordHash = hashWithSalt(String(password), salt);
    const result = await pool.query(
      `
        INSERT INTO admin_users (email, full_name, password_salt, password_hash, status)
        VALUES ($1, $2, $3, $4, 'active')
        RETURNING id, email, full_name, status, created_at
      `,
      [normalizedEmail, String(fullName).trim(), salt, passwordHash]
    );

    await logAudit({ action: 'admin_created', details: { adminId: result.rows[0].id, email: normalizedEmail }, req });
    return res.status(201).json({ ok: true, admin: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe un administrador con ese correo.' });
    }

    console.error('Error creando administrador:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo crear el administrador.' });
  }
});

app.patch('/admin/users/:id/status', requireAdminAuth, async (req, res) => {
  const adminId = Number(req.params.id);
  const { status } = req.body || {};

  if (!adminId || !['active', 'inactive'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Estado de administrador inválido.' });
  }

  try {
    if (status === 'inactive') {
      const activeAdmins = await pool.query(
        `SELECT COUNT(*)::int AS count FROM admin_users WHERE status = 'active'`
      );

      if (activeAdmins.rows[0].count <= 1) {
        return res.status(400).json({ ok: false, error: 'Debe quedar al menos un administrador activo.' });
      }
    }

    const result = await pool.query(
      `UPDATE admin_users SET status = $1 WHERE id = $2 RETURNING id, email, full_name, status, created_at`,
      [status, adminId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Administrador no encontrado.' });
    }

    if (status === 'inactive') {
      await pool.query('DELETE FROM admin_sessions WHERE admin_id = $1', [adminId]);
    }

    await logAudit({ action: 'admin_status_updated', details: { adminId, status }, req });
    return res.json({ ok: true, admin: result.rows[0] });
  } catch (error) {
    console.error('Error actualizando administrador:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar el administrador.' });
  }
});

app.get('/admin/clients', requireAdminAuth, async (req, res) => {
  try {
    const clientsResult = await pool.query(
      `
        SELECT c.*, COUNT(r.id)::int AS face_record_count
        FROM clients c
        LEFT JOIN rostros_usuarios r ON r.cliente_id = c.id
        GROUP BY c.id
        ORDER BY c.created_at DESC
      `
    );

    const keysResult = await pool.query(
      `
        SELECT *
        FROM client_api_keys
        ORDER BY created_at DESC
      `
    );

    const keysByClient = {};
    for (const keyRow of keysResult.rows) {
      if (!keysByClient[keyRow.client_id]) {
        keysByClient[keyRow.client_id] = [];
      }
      keysByClient[keyRow.client_id].push(keyRow);
    }

    const clients = clientsResult.rows.map((client) => ({
      ...client,
      apiKeys: keysByClient[client.id] || []
    }));

    return res.json({ ok: true, clients });
  } catch (error) {
    console.error('Error listando clientes:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar los clientes.' });
  }
});

app.get('/admin/clients/:id/keys', requireAdminAuth, async (req, res) => {
  const clientId = Number(req.params.id);

  if (!clientId) {
    return res.status(400).json({ ok: false, error: 'ID de cliente inválido.' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM client_api_keys WHERE client_id = $1 ORDER BY created_at DESC`,
      [clientId]
    );

    return res.json({ ok: true, keys: result.rows });
  } catch (error) {
    console.error('Error listando keys del cliente:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar las keys.' });
  }
});

app.delete('/admin/clients/:id/face-records', requireAdminAuth, async (req, res) => {
  const clientId = Number(req.params.id);

  if (!clientId) {
    return res.status(400).json({ ok: false, error: 'ID de cliente inválido.' });
  }

  try {
    const clientResult = await pool.query('SELECT id, name FROM clients WHERE id = $1', [clientId]);
    if (clientResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Cliente no encontrado.' });
    }

    const result = await pool.query(
      'DELETE FROM rostros_usuarios WHERE cliente_id = $1',
      [clientId]
    );

    await logAudit({
      clientId,
      action: 'client_face_records_deleted',
      details: {
        deletedCount: result.rowCount,
        clientName: clientResult.rows[0].name
      },
      req
    });

    return res.json({
      ok: true,
      deletedCount: result.rowCount,
      message: result.rowCount === 0
        ? 'El cliente no tenía registros faciales.'
        : `Se eliminaron ${result.rowCount} registros faciales.`
    });
  } catch (error) {
    console.error('Error eliminando registros faciales del cliente:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron eliminar los registros faciales.' });
  }
});

app.patch('/admin/clients/:id/status', requireAdminAuth, async (req, res) => {
  const clientId = Number(req.params.id);
  const { status } = req.body || {};

  if (!clientId || !['active', 'inactive', 'revoked'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Estado inválido.' });
  }

  try {
    const result = await pool.query(
      `UPDATE clients SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, clientId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Cliente no encontrado.' });
    }

    await logAudit({ clientId, action: 'client_status_updated', details: { status }, req });
    return res.json({ ok: true, client: result.rows[0] });
  } catch (error) {
    console.error('Error actualizando estado del cliente:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar el cliente.' });
  }
});

app.patch('/admin/keys/:id/status', requireAdminAuth, async (req, res) => {
  const keyId = Number(req.params.id);
  const { status } = req.body || {};

  if (!keyId || !['active', 'inactive', 'revoked'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Estado de key inválido.' });
  }

  try {
    const result = await pool.query(
      `UPDATE client_api_keys SET status = $1::varchar, revoked_at = CASE WHEN $1::varchar = 'revoked' THEN NOW() ELSE NULL END WHERE id = $2 RETURNING *`,
      [status, keyId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'API key no encontrada.' });
    }

    await logAudit({ clientKeyId: keyId, action: 'api_key_status_updated', details: { status }, req });
    return res.json({ ok: true, key: result.rows[0] });
  } catch (error) {
    console.error('Error actualizando estado de la key:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar la API key.' });
  }
});

app.post('/admin/clients', requireAdminAuth, async (req, res) => {
  const { name, email, company, status = 'active' } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ ok: false, error: 'Nombre y email son obligatorios.' });
  }

  try {
    const result = await pool.query(
      `
        INSERT INTO clients (name, email, company, status)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [String(name).trim(), String(email).trim().toLowerCase(), company || null, status]
    );

    await logAudit({ action: 'client_created', details: { clientId: result.rows[0].id }, req });
    return res.status(201).json({ ok: true, client: result.rows[0] });
  } catch (error) {
    console.error('Error creando cliente:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo crear el cliente.' });
  }
});

app.post('/admin/clients/:id/keys', requireAdminAuth, async (req, res) => {
  const clientId = Number(req.params.id);
  const { name, scopes = ['face:register', 'face:identify'], expiresAt } = req.body || {};

  if (!clientId || !name) {
    return res.status(400).json({ ok: false, error: 'ID del cliente y nombre de la key requeridos.' });
  }

  const client = await pool.connect();

  try {
    const rawKey = generateApiKey('face');
    const salt = generateSalt();
    const keyHash = hashWithSalt(rawKey, salt);
    const normalizedScopes = normalizeScopes(scopes);

    await client.query('BEGIN');

    const revokedKeys = await client.query(
      `
        UPDATE client_api_keys
        SET status = 'revoked', revoked_at = NOW()
        WHERE client_id = $1 AND status = 'active'
        RETURNING id
      `,
      [clientId]
    );

    const result = await client.query(
      `
        INSERT INTO client_api_keys (client_id, name, key_salt, key_hash, scopes, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, 'active', $6)
        RETURNING *
      `,
      [clientId, String(name).trim(), salt, keyHash, normalizedScopes, expiresAt || null]
    );

    await client.query('COMMIT');
    await logAudit({ clientId, clientKeyId: result.rows[0].id, action: 'api_key_created', details: { keyName: name }, req });

    for (const revokedKey of revokedKeys.rows) {
      await logAudit({ clientId, clientKeyId: revokedKey.id, action: 'api_key_status_updated', details: { status: 'revoked', reason: 'replaced_by_new_key' }, req });
    }

    return res.status(201).json({
      ok: true,
      replacedCount: revokedKeys.rowCount,
      key: {
        ...result.rows[0],
        rawKey
      }
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error creando key:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo crear la API key.' });
  } finally {
    client.release();
  }
});

app.get('/admin/audit', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT *
        FROM audit_logs
        ORDER BY created_at DESC
        LIMIT 100
      `
    );

    return res.json({ ok: true, logs: result.rows });
  } catch (error) {
    console.error('Error listando auditoría:', error);
    return res.status(500).json({ ok: false, error: 'No se pudo consultar la auditoría.' });
  }
});

app.post('/api/rostros/registrar', requireClientApiKey, async (req, res) => {
  try {
    const { usuario_id, embedding, embeddings } = req.body || {};
    const muestras = Array.isArray(embeddings) ? embeddings : [embedding];

    if (!usuario_id || muestras.length < 1 || muestras.length > 10 || muestras.some((muestra) => !Array.isArray(muestra) || muestra.length !== 128)) {
      return res.status(400).json({
        ok: false,
        error: 'Se requiere usuario_id y entre 1 y 10 embeddings vector(128).'
      });
    }

    const client = await pool.connect();
    let inserted;
    try {
      await client.query('BEGIN');
      const values = [];
      const placeholders = muestras.map((muestra, index) => {
        const offset = index * 3;
        values.push(req.client.id, Number(usuario_id), `[${muestra.join(',')}]`);
        return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
      });
      inserted = await client.query(
        `
          INSERT INTO rostros_usuarios (cliente_id, usuario_id, embedding)
          VALUES ${placeholders.join(', ')}
          RETURNING id, usuario_id, created_at
        `,
        values
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await logAudit({
      clientId: req.client.id,
      clientKeyId: req.apiKey.id,
      action: 'face_registered',
      details: { usuario_id: Number(usuario_id), muestras: muestras.length, client: req.client.client_name },
      req
    });

    return res.status(201).json({
      ok: true,
      mensaje: `${muestras.length} muestras faciales registradas correctamente.`,
      muestras: inserted.rows
    });
  } catch (err) {
    console.error('Error al registrar rostro:', err);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo registrar el rostro.'
    });
  }
});

app.post('/api/rostros/identificar', requireClientApiKey, async (req, res) => {
  try {
    const { embedding } = req.body || {};

    if (!Array.isArray(embedding) || embedding.length !== 128 || !embedding.every((value) => Number.isFinite(Number(value)))) {
      return res.status(400).json({
        ok: false,
        error: 'Se requiere un embedding numérico vector(128).'
      });
    }

    const query = `
      SELECT id, usuario_id, created_at,
             embedding <-> $1 AS distancia_euclidiana
      FROM rostros_usuarios
      WHERE cliente_id = $2
        AND (embedding <-> $1) < $3
      ORDER BY embedding <-> $1
      LIMIT 2;
    `;

    const result = await pool.query(query, [
      `[${embedding.join(',')}]`,
      req.client.id,
      FACE_MATCH_DISTANCE_THRESHOLD
    ]);

    if (result.rows.length === 0) {
      return res.status(200).json({
        encontrado: false,
        mensaje: 'No se encontró coincidencia.',
        usuario_id: null,
        distancia_euclidiana: null,
        ambigua: false,
        umbral_distancia: FACE_MATCH_DISTANCE_THRESHOLD
      });
    }

    const candidato = result.rows[0];
    const distanciaEuclidiana = Number(candidato.distancia_euclidiana);
    const segundoCandidato = result.rows[1];
    const segundaDistancia = segundoCandidato ? Number(segundoCandidato.distancia_euclidiana) : null;
    const hayAmbiguedad = segundoCandidato
      && segundoCandidato.usuario_id !== candidato.usuario_id
      && segundaDistancia - distanciaEuclidiana < FACE_MATCH_MARGIN;
    const encontrado = Number.isFinite(distanciaEuclidiana)
      && distanciaEuclidiana < FACE_MATCH_DISTANCE_THRESHOLD
      && !hayAmbiguedad;

    await logAudit({
      clientId: req.client.id,
      clientKeyId: req.apiKey.id,
      action: 'face_identified',
      details: {
        encontrado,
        usuario_id: candidato.usuario_id,
        distancia_euclidiana: distanciaEuclidiana,
        segunda_distancia_euclidiana: segundaDistancia,
        ambigua: Boolean(hayAmbiguedad),
        umbral_distancia: FACE_MATCH_DISTANCE_THRESHOLD,
        margen_ambiguidad: FACE_MATCH_MARGIN
      },
      req
    });

    return res.status(200).json({
      encontrado,
      mensaje: encontrado
        ? 'Rostro identificado correctamente.'
        : 'No se encontró un rostro suficientemente similar.',
      usuario_id: encontrado ? candidato.usuario_id : null,
      distancia_euclidiana: distanciaEuclidiana,
      ambigua: Boolean(hayAmbiguedad),
      umbral_distancia: FACE_MATCH_DISTANCE_THRESHOLD
    });
  } catch (err) {
    console.error('Error al identificar rostro:', err);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo identificar el rostro.'
    });
  }
});

async function startServer() {
  await ensureSeedAdmin();

  app.listen(PORT, () => {
    console.log(`Microservicio Node.js escuchando en http://localhost:${PORT}`);
    console.log('Consola admin: http://localhost:3000/admin');
  });
}

startServer().catch((error) => {
  console.error('Error arrancando el servidor:', error.message);
  process.exit(1);
});
