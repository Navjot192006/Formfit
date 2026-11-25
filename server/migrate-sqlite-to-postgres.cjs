"use strict";

const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { openDatabase, createDatabaseStore } = require("./database.cjs");

const TABLES = {
    users: ["id", "name", "email", "password_hash", "password_salt", "provider", "picture", "created_at", "role"],
    sessions: ["token_hash", "user_id", "guest_id", "created_at", "expires_at"],
    workouts: [
        "id", "user_id", "guest_id", "date", "title", "notes", "exercise", "form_score", "rep_count",
        "range_of_motion", "tempo", "legacy_id"
    ],
    workout_reps: [
        "workout_id", "rep_number", "form_score", "range_of_motion", "duration", "confidence", "side",
        "depth_score", "hip_score", "torso_score", "bottom_stability_score", "knee_angle", "hip_angle",
        "torso_angle", "elbow_stability_score", "rom_score", "tempo_score", "top_angle", "bottom_angle",
        "feedback_json"
    ],
    video_assets: [
        "id", "user_id", "guest_id", "workout_id", "storage_key", "file_name", "content_type", "size_bytes",
        "duration_seconds", "created_at"
    ]
};

function tableExists(sqlite, name) {
    return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function readRows(sqlite, table) {
    if (!tableExists(sqlite, table)) return [];
    return sqlite.prepare(`SELECT * FROM "${table}"`).all();
}

async function insertRows(client, table, columns, rows, mapRow = (row) => row) {
    if (!rows.length) return 0;
    const names = columns.map((name) => `"${name}"`).join(", ");
    const values = columns.map((_, index) => `$${index + 1}`).join(", ");
    const query = `INSERT INTO "${table}" (${names}) VALUES (${values})`;
    for (const sourceRow of rows) {
        const row = mapRow(sourceRow);
        await client.query(query, columns.map((column) => row[column] ?? null));
    }
    return rows.length;
}

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error("Set DATABASE_URL in your .env file to the PostgreSQL connection string before migrating.");
    }

    const sqlitePath = path.resolve(process.env.SQLITE_PATH || path.join(__dirname, "data", "formfit.sqlite"));
    const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
    const database = openDatabase();
    const store = createDatabaseStore(database);
    let connection;

    try {
        await store.ready;
        connection = await database.pool.connect();

        const destination = await connection.query(
            "SELECT (SELECT COUNT(*) FROM users) AS users, " +
            "(SELECT COUNT(*) FROM sessions) AS sessions, " +
            "(SELECT COUNT(*) FROM workouts) AS workouts, " +
            "(SELECT COUNT(*) FROM workout_reps) AS workout_reps, " +
            "(SELECT COUNT(*) FROM video_assets) AS video_assets"
        );
        if (Object.values(destination.rows[0]).some((count) => Number(count) > 0)) {
            throw new Error("The PostgreSQL tables already contain data. Migration stopped to avoid overwriting it; use a fresh empty database.");
        }

        const sourceRows = Object.fromEntries(Object.keys(TABLES).map((table) => [table, readRows(sqlite, table)]));
        if (!sourceRows.users.length && !sourceRows.workouts.length) {
            throw new Error(`No accounts or workouts were found in ${sqlitePath}.`);
        }

        const counts = {};
        await connection.query("BEGIN");
        try {
            counts.users = await insertRows(connection, "users", TABLES.users, sourceRows.users, (row) => ({
                ...row,
                email: String(row.email).toLowerCase(),
                role: row.role || "student"
            }));
            counts.sessions = await insertRows(connection, "sessions", TABLES.sessions, sourceRows.sessions);
            counts.workouts = await insertRows(connection, "workouts", TABLES.workouts, sourceRows.workouts);
            counts.workout_reps = await insertRows(connection, "workout_reps", TABLES.workout_reps, sourceRows.workout_reps,
                (row) => ({ ...row, feedback_json: row.feedback_json || "[]" }));
            counts.video_assets = await insertRows(connection, "video_assets", TABLES.video_assets, sourceRows.video_assets);
            await connection.query("COMMIT");
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        }

        console.log("SQLite data copied to PostgreSQL:");
        for (const [table, count] of Object.entries(counts)) console.log(`  ${table}: ${count}`);
        console.log("Your SQLite file was kept as a backup. Restart the app with DATABASE_URL set to use PostgreSQL.");
    } finally {
        connection?.release();
        sqlite.close();
        await database.close();
    }
}

main().catch((error) => {
    console.error("PostgreSQL migration failed:", error.message);
    process.exitCode = 1;
});
