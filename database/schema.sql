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

CREATE INDEX IF NOT EXISTS idx_admin_users_status
ON admin_users (status);

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
