import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const dataDirectory = path.resolve(process.env.BINKSALAD_DATA_DIR || 'data');
mkdirSync(dataDirectory, { recursive: true });

export const databasePath = path.join(dataDirectory, 'binksalad.sqlite');
export const db = new Database(databasePath);

db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    kakao_user_id TEXT,
    kakao_nickname TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    household_type TEXT NOT NULL CHECK (household_type IN ('personal', 'shared')),
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS household_members (
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'administrator', 'member')),
    permission TEXT NOT NULL DEFAULT 'edit' CHECK (permission IN ('view', 'edit')),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (household_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS household_accounts (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    bank_name TEXT NOT NULL DEFAULT '카카오뱅크',
    name TEXT NOT NULL,
    account_number_suffix TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (household_id, name)
  );

  CREATE TABLE IF NOT EXISTS household_invitations (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    invited_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    expires_at TEXT NOT NULL,
    accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS household_invitations_pending
    ON household_invitations(household_id, status, expires_at);

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category_type TEXT NOT NULL CHECK (category_type IN ('income', 'expense')),
    created_at TEXT NOT NULL,
    UNIQUE (household_id, name, category_type)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    account_id TEXT REFERENCES household_accounts(id) ON DELETE SET NULL,
    transaction_date TEXT NOT NULL,
    description TEXT NOT NULL,
    original_description TEXT NOT NULL,
    counterparty TEXT,
    amount INTEGER NOT NULL CHECK (amount != 0),
    balance INTEGER,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('income', 'expense')),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    category_manual INTEGER NOT NULL DEFAULT 0 CHECK (category_manual IN (0, 1)),
    source TEXT NOT NULL,
    external_key TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS transactions_external_key
    ON transactions(household_id, external_key) WHERE external_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS transactions_date
    ON transactions(household_id, transaction_date DESC);
  CREATE INDEX IF NOT EXISTS transactions_category
    ON transactions(household_id, category_id, transaction_date DESC);

  CREATE TABLE IF NOT EXISTS import_history (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    account_id TEXT REFERENCES household_accounts(id) ON DELETE SET NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    file_name TEXT NOT NULL,
    import_date TEXT NOT NULL,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    import_status TEXT NOT NULL,
    error_details TEXT
  );

  CREATE TABLE IF NOT EXISTS saved_credentials (
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    credential_owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_type TEXT NOT NULL,
    encrypted_password TEXT NOT NULL,
    encryption_iv TEXT NOT NULL,
    encryption_tag TEXT NOT NULL,
    encryption_key_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (household_id, credential_owner_id, credential_type)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('login', 'link')),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_token_hash TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    household_id TEXT REFERENCES households(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transaction_audit_logs (
    id TEXT PRIMARY KEY,
    transaction_id TEXT,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    previous_values TEXT,
    new_values TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS category_rules (
    id INTEGER PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (household_id, keyword)
  );
`);

const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
if (!userColumns.has('kakao_user_id')) db.exec('ALTER TABLE users ADD COLUMN kakao_user_id TEXT');
if (!userColumns.has('kakao_nickname')) db.exec('ALTER TABLE users ADD COLUMN kakao_nickname TEXT');
const householdMemberColumns = new Set(db.prepare('PRAGMA table_info(household_members)').all().map(column => column.name));
if (!householdMemberColumns.has('permission')) {
  db.exec("ALTER TABLE household_members ADD COLUMN permission TEXT NOT NULL DEFAULT 'edit' CHECK (permission IN ('view', 'edit'))");
}
const transactionColumns = new Set(db.prepare('PRAGMA table_info(transactions)').all().map(column => column.name));
if (!transactionColumns.has('account_id')) db.exec('ALTER TABLE transactions ADD COLUMN account_id TEXT REFERENCES household_accounts(id) ON DELETE SET NULL');
const importHistoryColumns = new Set(db.prepare('PRAGMA table_info(import_history)').all().map(column => column.name));
if (!importHistoryColumns.has('account_id')) db.exec('ALTER TABLE import_history ADD COLUMN account_id TEXT REFERENCES household_accounts(id) ON DELETE SET NULL');
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS users_kakao_user_id
  ON users(kakao_user_id) WHERE kakao_user_id IS NOT NULL
`);
db.exec(`
  DROP INDEX IF EXISTS transactions_external_key;
  CREATE UNIQUE INDEX IF NOT EXISTS transactions_external_key_by_account
    ON transactions(household_id, account_id, external_key)
    WHERE external_key IS NOT NULL AND account_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS transactions_external_key_legacy
    ON transactions(household_id, external_key)
    WHERE external_key IS NOT NULL AND account_id IS NULL;
`);

export const seedCategories = db.transaction((householdId) => {
  const timestamp = new Date().toISOString();
  const categories = [
    ['회비', 'income'],
    ['기타 수입', 'income'],
    ['보증금', 'income'],
    ['환불', 'income'],
    ['이자', 'income'],
    ['예금이자', 'income'],
    ['식비', 'expense'],
    ['생활용품', 'expense'],
    ['생활', 'expense'],
    ['인터넷비', 'expense'],
    ['관리비', 'expense'],
    ['월세', 'expense'],
    ['대출이자', 'expense'],
    ['이사', 'expense'],
    ['기타 지출', 'expense'],
    ['미분류', 'expense'],
    ['미분류', 'income']
  ];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO categories (household_id, name, category_type, created_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const [name, type] of categories) insert.run(householdId, name, type, timestamp);
});
