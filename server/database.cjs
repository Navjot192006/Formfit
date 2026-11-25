"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function openDatabase(filename) {
    if (filename === undefined && process.env.DATABASE_URL) {
        let Pool;
        try {
            ({ Pool } = require("pg"));
        } catch {
            throw new Error("PostgreSQL is configured but the pg package is missing. Run npm install.");
        }
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: true } : undefined
        });
        return { __formfitPostgres: true, pool, close: () => pool.end() };
    }

    filename ||= path.join(__dirname, "data", "formfit.sqlite");
    if (filename !== ":memory:") {
        fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    }

    const db = new DatabaseSync(filename);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec([
        "CREATE TABLE IF NOT EXISTS users (",
        " id TEXT PRIMARY KEY,",
        " name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),",
        " email TEXT NOT NULL COLLATE NOCASE UNIQUE,",
        " password_hash TEXT,",
        " password_salt TEXT,",
        " provider TEXT NOT NULL DEFAULT 'password' CHECK (provider IN ('password', 'google')),",
        " picture TEXT NOT NULL DEFAULT '',",
        " created_at TEXT NOT NULL,",
        " role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher'))",
        ");",
        "CREATE TABLE IF NOT EXISTS sessions (",
        " token_hash TEXT PRIMARY KEY,",
        " user_id TEXT REFERENCES users(id) ON DELETE CASCADE,",
        " guest_id TEXT,",
        " created_at TEXT NOT NULL,",
        " expires_at TEXT NOT NULL,",
        " CHECK ((user_id IS NULL) <> (guest_id IS NULL))",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);",
        "CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);",
        "CREATE TABLE IF NOT EXISTS workouts (",
        " id TEXT PRIMARY KEY,",
        " user_id TEXT REFERENCES users(id) ON DELETE CASCADE,",
        " guest_id TEXT,",
        " date TEXT NOT NULL,",
        " title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 60),",
        " notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 400),",
        " exercise TEXT NOT NULL CHECK (exercise IN ('squat', 'bicep-curl')),",
        " form_score REAL CHECK (form_score IS NULL OR form_score BETWEEN 0 AND 100),",
        " rep_count INTEGER NOT NULL DEFAULT 0 CHECK (rep_count BETWEEN 0 AND 1000),",
        " range_of_motion REAL CHECK (range_of_motion IS NULL OR range_of_motion BETWEEN 0 AND 360),",
        " tempo REAL CHECK (tempo IS NULL OR tempo BETWEEN 0 AND 3600),",
        " legacy_id TEXT,",
        " CHECK ((user_id IS NULL) <> (guest_id IS NULL))",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date DESC);",
        "CREATE INDEX IF NOT EXISTS idx_workouts_guest_date ON workouts(guest_id, date DESC);",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_user_legacy ON workouts(user_id, legacy_id) WHERE user_id IS NOT NULL AND legacy_id IS NOT NULL;",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_guest_legacy ON workouts(guest_id, legacy_id) WHERE guest_id IS NOT NULL AND legacy_id IS NOT NULL;",
        "CREATE TABLE IF NOT EXISTS workout_reps (",
        " workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,",
        " rep_number INTEGER NOT NULL CHECK (rep_number BETWEEN 1 AND 1000),",
        " form_score REAL CHECK (form_score IS NULL OR form_score BETWEEN 0 AND 100),",
        " range_of_motion REAL CHECK (range_of_motion IS NULL OR range_of_motion BETWEEN 0 AND 360),",
        " duration REAL CHECK (duration IS NULL OR duration BETWEEN 0 AND 3600),",
        " confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),",
        " side TEXT,",
        " depth_score REAL CHECK (depth_score IS NULL OR depth_score BETWEEN 0 AND 100),",
        " hip_score REAL CHECK (hip_score IS NULL OR hip_score BETWEEN 0 AND 100),",
        " torso_score REAL CHECK (torso_score IS NULL OR torso_score BETWEEN 0 AND 100),",
        " bottom_stability_score REAL CHECK (bottom_stability_score IS NULL OR bottom_stability_score BETWEEN 0 AND 100),",
        " knee_angle REAL CHECK (knee_angle IS NULL OR knee_angle BETWEEN -360 AND 360),",
        " hip_angle REAL CHECK (hip_angle IS NULL OR hip_angle BETWEEN -360 AND 360),",
        " torso_angle REAL CHECK (torso_angle IS NULL OR torso_angle BETWEEN -360 AND 360),",
        " elbow_stability_score REAL CHECK (elbow_stability_score IS NULL OR elbow_stability_score BETWEEN 0 AND 100),",
        " rom_score REAL CHECK (rom_score IS NULL OR rom_score BETWEEN 0 AND 100),",
        " tempo_score REAL CHECK (tempo_score IS NULL OR tempo_score BETWEEN 0 AND 100),",
        " top_angle REAL CHECK (top_angle IS NULL OR top_angle BETWEEN -360 AND 360),",
        " bottom_angle REAL CHECK (bottom_angle IS NULL OR bottom_angle BETWEEN -360 AND 360),",
        " feedback_json TEXT NOT NULL DEFAULT '[]',",
        " PRIMARY KEY (workout_id, rep_number)",
        ");",
        "CREATE TABLE IF NOT EXISTS video_assets (",
        " id TEXT PRIMARY KEY,",
        " user_id TEXT REFERENCES users(id) ON DELETE CASCADE,",
        " guest_id TEXT,",
        " workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL,",
        " storage_key TEXT NOT NULL UNIQUE,",
        " file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),",
        " content_type TEXT NOT NULL CHECK (content_type LIKE 'video/%'),",
        " size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),",
        " duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),",
        " created_at TEXT NOT NULL,",
        " CHECK ((user_id IS NULL) <> (guest_id IS NULL))",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_video_assets_user_created ON video_assets(user_id, created_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_video_assets_workout ON video_assets(workout_id);"
    ].join("\n"));

    const userColumns = db.prepare("PRAGMA table_info(users)").all();
    if (!userColumns.some((column) => column.name === "role")) {
        db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher'))");
    }

    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
    return db;
}

function pgSql(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => "$" + (++index));
}

function prepared(execute, sql) {
    const query = pgSql(sql);
    return {
        async get(...params) {
            const result = await execute(query, params);
            return result.rows[0];
        },
        async all(...params) {
            const result = await execute(query, params);
            return result.rows;
        },
        async run(...params) {
            const result = await execute(query, params);
            return { changes: result.rowCount };
        }
    };
}

const POSTGRES_SCHEMA = [
    "CREATE TABLE IF NOT EXISTS users (",
    " id TEXT PRIMARY KEY,",
    " name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),",
    " email TEXT NOT NULL UNIQUE,",
    " password_hash TEXT, password_salt TEXT,",
    " provider TEXT NOT NULL DEFAULT 'password' CHECK (provider IN ('password', 'google')),",
    " picture TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,",
    " role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher'))",
    ");",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher'));",
    "CREATE TABLE IF NOT EXISTS sessions (",
    " token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,",
    " guest_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,",
    " CHECK ((user_id IS NULL) <> (guest_id IS NULL))",
    ");",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);",
    "CREATE TABLE IF NOT EXISTS workouts (",
    " id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, guest_id TEXT,",
    " date TEXT NOT NULL, title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 60),",
    " notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 400),",
    " exercise TEXT NOT NULL CHECK (exercise IN ('squat', 'bicep-curl')),",
    " form_score DOUBLE PRECISION CHECK (form_score IS NULL OR form_score BETWEEN 0 AND 100),",
    " rep_count INTEGER NOT NULL DEFAULT 0 CHECK (rep_count BETWEEN 0 AND 1000),",
    " range_of_motion DOUBLE PRECISION CHECK (range_of_motion IS NULL OR range_of_motion BETWEEN 0 AND 360),",
    " tempo DOUBLE PRECISION CHECK (tempo IS NULL OR tempo BETWEEN 0 AND 3600), legacy_id TEXT,",
    " CHECK ((user_id IS NULL) <> (guest_id IS NULL))",
    ");",
    "CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date DESC);",
    "CREATE INDEX IF NOT EXISTS idx_workouts_guest_date ON workouts(guest_id, date DESC);",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_user_legacy ON workouts(user_id, legacy_id) WHERE user_id IS NOT NULL AND legacy_id IS NOT NULL;",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_guest_legacy ON workouts(guest_id, legacy_id) WHERE guest_id IS NOT NULL AND legacy_id IS NOT NULL;",
    "CREATE TABLE IF NOT EXISTS workout_reps (",
    " workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE, rep_number INTEGER NOT NULL CHECK (rep_number BETWEEN 1 AND 1000),",
    " form_score DOUBLE PRECISION CHECK (form_score IS NULL OR form_score BETWEEN 0 AND 100),",
    " range_of_motion DOUBLE PRECISION CHECK (range_of_motion IS NULL OR range_of_motion BETWEEN 0 AND 360),",
    " duration DOUBLE PRECISION CHECK (duration IS NULL OR duration BETWEEN 0 AND 3600),",
    " confidence DOUBLE PRECISION CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100), side TEXT,",
    " depth_score DOUBLE PRECISION CHECK (depth_score IS NULL OR depth_score BETWEEN 0 AND 100),",
    " hip_score DOUBLE PRECISION CHECK (hip_score IS NULL OR hip_score BETWEEN 0 AND 100),",
    " torso_score DOUBLE PRECISION CHECK (torso_score IS NULL OR torso_score BETWEEN 0 AND 100),",
    " bottom_stability_score DOUBLE PRECISION CHECK (bottom_stability_score IS NULL OR bottom_stability_score BETWEEN 0 AND 100),",
    " knee_angle DOUBLE PRECISION CHECK (knee_angle IS NULL OR knee_angle BETWEEN -360 AND 360),",
    " hip_angle DOUBLE PRECISION CHECK (hip_angle IS NULL OR hip_angle BETWEEN -360 AND 360),",
    " torso_angle DOUBLE PRECISION CHECK (torso_angle IS NULL OR torso_angle BETWEEN -360 AND 360),",
    " elbow_stability_score DOUBLE PRECISION CHECK (elbow_stability_score IS NULL OR elbow_stability_score BETWEEN 0 AND 100),",
    " rom_score DOUBLE PRECISION CHECK (rom_score IS NULL OR rom_score BETWEEN 0 AND 100),",
    " tempo_score DOUBLE PRECISION CHECK (tempo_score IS NULL OR tempo_score BETWEEN 0 AND 100),",
    " top_angle DOUBLE PRECISION CHECK (top_angle IS NULL OR top_angle BETWEEN -360 AND 360),",
    " bottom_angle DOUBLE PRECISION CHECK (bottom_angle IS NULL OR bottom_angle BETWEEN -360 AND 360),",
    " feedback_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (workout_id, rep_number)",
    ");",
    "CREATE TABLE IF NOT EXISTS video_assets (",
    " id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, guest_id TEXT,",
    " workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL, storage_key TEXT NOT NULL UNIQUE,",
    " file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),",
    " content_type TEXT NOT NULL CHECK (content_type LIKE 'video/%'),",
    " size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),",
    " duration_seconds DOUBLE PRECISION CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),",
    " created_at TEXT NOT NULL, CHECK ((user_id IS NULL) <> (guest_id IS NULL))",
    ");",
    "CREATE INDEX IF NOT EXISTS idx_video_assets_user_created ON video_assets(user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_video_assets_workout ON video_assets(workout_id);"
].join("\n");

function createDatabaseStore(database) {
    if (database?.__formfitPostgres) {
        const pool = database.pool;
        const fromClient = (client) => ({
            prepare(sql) {
                return prepared((query, params) => client.query(query, params), sql);
            },
            async transaction(callback) {
                const connection = await pool.connect();
                try {
                    await connection.query("BEGIN");
                    const result = await callback(fromClient(connection));
                    await connection.query("COMMIT");
                    return result;
                } catch (error) {
                    await connection.query("ROLLBACK");
                    throw error;
                } finally {
                    connection.release();
                }
            },
            ready: Promise.resolve()
        });
        const store = fromClient(pool);
        store.ready = pool.query(POSTGRES_SCHEMA).then(() =>
            pool.query("DELETE FROM sessions WHERE expires_at <= $1", [new Date().toISOString()])
        );
        return store;
    }

    return {
        ready: Promise.resolve(),
        prepare(sql) {
            const statement = database.prepare(sql);
            return {
                async get(...params) { return statement.get(...params); },
                async all(...params) { return statement.all(...params); },
                async run(...params) { return statement.run(...params); }
            };
        },
        async transaction(callback) {
            database.exec("BEGIN IMMEDIATE");
            try {
                const result = await callback(this);
                database.exec("COMMIT");
                return result;
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        },
        async close() { database.close(); }
    };
}

module.exports = { openDatabase, createDatabaseStore };
