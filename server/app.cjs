"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { openDatabase, createDatabaseStore } = require("./database.cjs");

const SESSION_COOKIE = "ff_session";
const LIVE_SERVER_ORIGINS = new Set([
    "http://127.0.0.1:5500",
    "http://localhost:5500"
]);
const GOOGLE_CLIENT_ID =
    process.env.GOOGLE_CLIENT_ID ||
    "488339339167-trleruvrpb86erfi00ekh1ta9vq5tmvs.apps.googleusercontent.com";
const PUBLIC_USER_SQL =
    "SELECT id, name, email, provider, picture, role, created_at AS \"createdAt\" FROM users WHERE id = ?";
const MAX_BODY_BYTES = 1024 * 1024;
const PASSWORD_ITERATIONS = 210000;

class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function fail(status, code, message) {
    throw new HttpError(status, code, message);
}

function isUniqueViolation(error) {
    return error?.code === "23505" || String(error?.message || "").includes("UNIQUE");
}

function sendJson(res, status, value, headers = {}) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        ...headers
    });
    res.end(body);
}

function sendNoContent(res, headers = {}) {
    res.writeHead(204, { "Cache-Control": "no-store", ...headers });
    res.end();
}

function parseCookies(req) {
    const out = Object.create(null);
    for (const part of (req.headers.cookie || "").split(";")) {
        const index = part.indexOf("=");
        if (index < 0) continue;
        const name = part.slice(0, index).trim();
        try {
            out[name] = decodeURIComponent(part.slice(index + 1).trim());
        } catch {
            out[name] = "";
        }
    }
    return out;
}

function setCookie(res, token, req, maxAge) {
    const pieces = [
        SESSION_COOKIE + "=" + encodeURIComponent(token),
        "Path=/",
        "HttpOnly",
        "SameSite=Lax"
    ];
    if (Number.isFinite(maxAge)) pieces.push("Max-Age=" + String(maxAge));
    if (req.socket.encrypted || process.env.NODE_ENV === "production") pieces.push("Secure");
    res.setHeader("Set-Cookie", pieces.join("; "));
}

function clearCookie(res, req) {
    const pieces = [
        SESSION_COOKIE + "=",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0"
    ];
    if (req.socket.encrypted || process.env.NODE_ENV === "production") pieces.push("Secure");
    res.setHeader("Set-Cookie", pieces.join("; "));
}

function tokenHash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

async function findSession(req, db) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    return await db.prepare(
        "SELECT token_hash, user_id, guest_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?"
    ).get(tokenHash(token), new Date().toISOString()) || null;
}

async function createSession(db, owner, maxAgeSeconds) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + maxAgeSeconds * 1000).toISOString();
    await db.prepare(
        "INSERT INTO sessions (token_hash, user_id, guest_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
        tokenHash(token),
        owner.userId || null,
        owner.guestId || null,
        now.toISOString(),
        expiresAt
    );
    return token;
}

async function activateUserSession(req, res, db, userId, maxAgeSeconds, cookieMaxAge = maxAgeSeconds) {
    const previous = await findSession(req, db);
    if (previous) {
        if (previous.guest_id) {
            await db.prepare("UPDATE workouts SET user_id = ?, guest_id = NULL WHERE guest_id = ?")
                .run(userId, previous.guest_id);
        }
        await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(previous.token_hash);
    }
    const token = await createSession(db, { userId }, maxAgeSeconds);
    setCookie(res, token, req, cookieMaxAge);
}

async function ownerForWorkouts(req, res, db) {
    const session = await findSession(req, db);
    if (session) {
        return session.user_id
            ? { userId: session.user_id, guestId: null }
            : { userId: null, guestId: session.guest_id };
    }

    const guestId = crypto.randomUUID();
    const token = await createSession(db, { guestId }, 365 * 24 * 60 * 60);
    setCookie(res, token, req, 365 * 24 * 60 * 60);
    return { userId: null, guestId };
}

async function requireUser(req, db) {
    const session = await findSession(req, db);
    if (!session || !session.user_id) fail(401, "AUTH_REQUIRED", "Please log in to continue.");
    const user = await db.prepare(PUBLIC_USER_SQL).get(session.user_id);
    if (!user) fail(401, "AUTH_REQUIRED", "Please log in to continue.");
    return user;
}

async function requireTeacher(req, db) {
    const user = await requireUser(req, db);
    if (user.role !== "teacher") fail(403, "TEACHER_REQUIRED", "Teacher access is required.");
    return user;
}

function validatedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return null;
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        fail(403, "ORIGIN_DENIED", "This request origin is not allowed.");
    }
    const protocol = req.socket.encrypted ? "https:" : "http:";
    const sameOrigin = parsed.host.toLowerCase() === String(req.headers.host || "").toLowerCase()
        && parsed.protocol === protocol;
    const allowedLiveServer = process.env.NODE_ENV !== "production"
        && LIVE_SERVER_ORIGINS.has(parsed.origin);
    if (!sameOrigin && !allowedLiveServer) {
        fail(403, "ORIGIN_DENIED", "This request origin is not allowed.");
    }
    return parsed.origin;
}

function applyApiCors(req, res) {
    const origin = validatedOrigin(req);
    if (!origin) return;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    if (req.method.toUpperCase() === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
    }
}

async function readJson(req) {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
        fail(415, "JSON_REQUIRED", "Send this request as application/json.");
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            tooLarge = true;
            continue;
        }
        chunks.push(chunk);
    }
    if (tooLarge) fail(413, "BODY_TOO_LARGE", "The request body is too large.");

    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            fail(400, "INVALID_JSON", "The JSON body must be an object.");
        }
        return parsed;
    } catch (error) {
        if (error instanceof HttpError) throw error;
        fail(400, "INVALID_JSON", "The request body contains invalid JSON.");
    }
}

function requireString(value, field, min, max, { trim = true } = {}) {
    if (typeof value !== "string") fail(400, "VALIDATION_ERROR", field + " must be text.");
    const result = trim ? value.trim() : value;
    if (result.length < min || result.length > max) {
        fail(400, "VALIDATION_ERROR", field + " must be between " + min + " and " + max + " characters.");
    }
    if (/[\u0000-\u001f\u007f]/.test(result)) {
        fail(400, "VALIDATION_ERROR", field + " contains unsupported characters.");
    }
    return result;
}

function normalizeEmail(value) {
    const email = requireString(value, "Email", 3, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        fail(400, "VALIDATION_ERROR", "Enter a valid email address.");
    }
    return email;
}

function validateSignup(body) {
    const name = requireString(body.name, "Name", 2, 60);
    const email = normalizeEmail(body.email);
    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128) {
        fail(400, "VALIDATION_ERROR", "Password must be between 8 and 128 characters.");
    }
    return { name, email, password: body.password };
}

function validateAdminProfileChanges(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        fail(400, "VALIDATION_ERROR", "Provide a profile object to update.");
    }
    const keys = Object.keys(body);
    const allowed = new Set(["name", "email"]);
    if (!keys.length || keys.some((key) => !allowed.has(key))) {
        fail(400, "VALIDATION_ERROR", "Provide a name or email address to update.");
    }
    const changes = {};
    if (Object.hasOwn(body, "name")) changes.name = requireString(body.name, "Name", 2, 60);
    if (Object.hasOwn(body, "email")) changes.email = normalizeEmail(body.email);
    return changes;
}

function validateNumber(value, field, min, max) {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        fail(400, "VALIDATION_ERROR", field + " must be a number between " + min + " and " + max + ".");
    }
    return value;
}

const REP_METRICS = {
    formScore: [0, 100],
    rangeOfMotion: [0, 360],
    duration: [0, 3600],
    confidence: [0, 100],
    depthScore: [0, 100],
    hipScore: [0, 100],
    torsoScore: [0, 100],
    bottomStabilityScore: [0, 100],
    kneeAngle: [-360, 360],
    hipAngle: [-360, 360],
    torsoAngle: [-360, 360],
    elbowStabilityScore: [0, 100],
    romScore: [0, 100],
    tempoScore: [0, 100],
    topAngle: [-360, 360],
    bottomAngle: [-360, 360]
};

function validateRep(rep, index) {
    if (!rep || typeof rep !== "object" || Array.isArray(rep)) {
        fail(400, "VALIDATION_ERROR", "Each rep must be an object.");
    }
    const repNumber = rep.repNumber === undefined ? index + 1 : rep.repNumber;
    if (!Number.isInteger(repNumber) || repNumber < 1 || repNumber > 1000) {
        fail(400, "VALIDATION_ERROR", "Rep number must be an integer between 1 and 1000.");
    }

    const clean = { repNumber };
    for (const [field, [min, max]] of Object.entries(REP_METRICS)) {
        if (Object.hasOwn(rep, field)) {
            clean[field] = validateNumber(rep[field], field, min, max);
        }
    }
    if (Object.hasOwn(rep, "side")) {
        clean.side = rep.side === null ? null : requireString(rep.side, "Side", 1, 20);
    }
    if (Object.hasOwn(rep, "feedback")) {
        if (!Array.isArray(rep.feedback) || rep.feedback.length > 10) {
            fail(400, "VALIDATION_ERROR", "Rep feedback must be a list of at most 10 messages.");
        }
        clean.feedback = rep.feedback.map((item) => requireString(item, "Feedback", 1, 240));
    }
    return clean;
}

function validateWorkout(body) {
    const allowed = new Set([
        "exercise", "formScore", "repCount", "rangeOfMotion", "tempo", "reps", "title", "notes"
    ]);
    for (const key of Object.keys(body)) {
        if (!allowed.has(key)) fail(400, "VALIDATION_ERROR", "Unsupported workout field: " + key + ".");
    }
    if (!["squat", "bicep-curl"].includes(body.exercise)) {
        fail(400, "VALIDATION_ERROR", "Exercise must be squat or bicep-curl.");
    }
    if (body.reps !== undefined && (!Array.isArray(body.reps) || body.reps.length > 1000)) {
        fail(400, "VALIDATION_ERROR", "Reps must be a list of at most 1000 items.");
    }
    const reps = (body.reps || []).map(validateRep);
    const repCount = body.repCount === undefined ? reps.length : body.repCount;
    if (!Number.isInteger(repCount) || repCount < 0 || repCount > 1000) {
        fail(400, "VALIDATION_ERROR", "Rep count must be an integer between 0 and 1000.");
    }
    const formScore = body.formScore === undefined
        ? null : validateNumber(body.formScore, "Form score", 0, 100);
    const rangeOfMotion = body.rangeOfMotion === undefined
        ? null : validateNumber(body.rangeOfMotion, "Range of motion", 0, 360);
    const tempo = body.tempo === undefined
        ? null : validateNumber(body.tempo, "Tempo", 0, 3600);

    return {
        exercise: body.exercise,
        formScore,
        repCount,
        rangeOfMotion,
        tempo,
        reps,
        title: body.title === undefined ? "" : requireString(body.title, "Title", 0, 60),
        notes: body.notes === undefined ? "" : requireString(body.notes, "Notes", 0, 400)
    };
}

function validateWorkoutChanges(body) {
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => key !== "title" && key !== "notes")) {
        fail(400, "VALIDATION_ERROR", "Only title and notes can be edited.");
    }
    const changes = {};
    if (Object.hasOwn(body, "title")) changes.title = requireString(body.title, "Title", 0, 60);
    if (Object.hasOwn(body, "notes")) changes.notes = requireString(body.notes, "Notes", 0, 400);
    return changes;
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
    return {
        hash: crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256").toString("hex"),
        salt: salt.toString("hex")
    };
}

function passwordMatches(password, saltHex, expectedHex) {
    const salt = Buffer.from(saltHex, "hex");
    const actual = Buffer.from(hashPassword(password, salt).hash, "hex");
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function publicUser(db, id) {
    const row = await db.prepare(PUBLIC_USER_SQL).get(id);
    if (!row) return null;
    return { ...row, createdAt: row.createdAt };
}

async function mapWorkout(db, row) {
    if (!row) return null;
    const repRows = await db.prepare(
        "SELECT * FROM workout_reps WHERE workout_id = ? ORDER BY rep_number"
    ).all(row.id);
    const reps = repRows.map((item) => ({
        repNumber: item.rep_number,
        formScore: item.form_score,
        rangeOfMotion: item.range_of_motion,
        duration: item.duration,
        confidence: item.confidence,
        side: item.side,
        depthScore: item.depth_score,
        hipScore: item.hip_score,
        torsoScore: item.torso_score,
        bottomStabilityScore: item.bottom_stability_score,
        kneeAngle: item.knee_angle,
        hipAngle: item.hip_angle,
        torsoAngle: item.torso_angle,
        elbowStabilityScore: item.elbow_stability_score,
        romScore: item.rom_score,
        tempoScore: item.tempo_score,
        topAngle: item.top_angle,
        bottomAngle: item.bottom_angle,
        feedback: JSON.parse(item.feedback_json)
    }));
    return {
        id: row.id,
        userId: row.user_id || null,
        date: row.date,
        title: row.title,
        notes: row.notes,
        exercise: row.exercise,
        formScore: row.form_score,
        repCount: row.rep_count,
        rangeOfMotion: row.range_of_motion,
        tempo: row.tempo,
        reps
    };
}

async function insertWorkout(db, owner, data, options = {}) {
    if (options.legacyId) {
        const existing = owner.userId
            ? await db.prepare("SELECT * FROM workouts WHERE user_id = ? AND legacy_id = ?")
                .get(owner.userId, options.legacyId)
            : await db.prepare("SELECT * FROM workouts WHERE guest_id = ? AND legacy_id = ?")
                .get(owner.guestId, options.legacyId);
        if (existing) return mapWorkout(db, existing);
    }
    const id = crypto.randomUUID();
    const date = options.date || new Date().toISOString();
    await db.prepare(
        "INSERT INTO workouts (id, user_id, guest_id, date, title, notes, exercise, form_score, rep_count, range_of_motion, tempo, legacy_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
        id, owner.userId, owner.guestId, date, data.title, data.notes, data.exercise,
        data.formScore, data.repCount, data.rangeOfMotion, data.tempo, options.legacyId || null
    );
    const insertRep = db.prepare(
        "INSERT INTO workout_reps (workout_id, rep_number, form_score, range_of_motion, duration, confidence, side, depth_score, hip_score, torso_score, bottom_stability_score, knee_angle, hip_angle, torso_angle, elbow_stability_score, rom_score, tempo_score, top_angle, bottom_angle, feedback_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const rep of data.reps) {
        await insertRep.run(
            id,
            rep.repNumber,
            rep.formScore ?? null,
            rep.rangeOfMotion ?? null,
            rep.duration ?? null,
            rep.confidence ?? null,
            rep.side ?? null,
            rep.depthScore ?? null,
            rep.hipScore ?? null,
            rep.torsoScore ?? null,
            rep.bottomStabilityScore ?? null,
            rep.kneeAngle ?? null,
            rep.hipAngle ?? null,
            rep.torsoAngle ?? null,
            rep.elbowStabilityScore ?? null,
            rep.romScore ?? null,
            rep.tempoScore ?? null,
            rep.topAngle ?? null,
            rep.bottomAngle ?? null,
            JSON.stringify(rep.feedback || [])
        );
    }
    return mapWorkout(db, await db.prepare("SELECT * FROM workouts WHERE id = ?").get(id));
}

async function ownedWorkout(db, owner, id) {
    const row = owner.userId
        ? await db.prepare("SELECT * FROM workouts WHERE id = ? AND user_id = ?").get(id, owner.userId)
        : await db.prepare("SELECT * FROM workouts WHERE id = ? AND guest_id = ?").get(id, owner.guestId);
    return mapWorkout(db, row);
}

async function getWorkoutList(db, owner) {
    const rows = owner.userId
        ? await db.prepare("SELECT * FROM workouts WHERE user_id = ? ORDER BY date DESC").all(owner.userId)
        : await db.prepare("SELECT * FROM workouts WHERE guest_id = ? ORDER BY date DESC").all(owner.guestId);
    return Promise.all(rows.map((row) => mapWorkout(db, row)));
}

async function removeOwnedWorkout(db, owner, id) {
    const result = owner.userId
        ? await db.prepare("DELETE FROM workouts WHERE id = ? AND user_id = ?").run(id, owner.userId)
        : await db.prepare("DELETE FROM workouts WHERE id = ? AND guest_id = ?").run(id, owner.guestId);
    return result.changes > 0;
}

async function updateOwnedWorkout(db, owner, id, changes) {
    const existing = await ownedWorkout(db, owner, id);
    if (!existing) return null;
    const title = Object.hasOwn(changes, "title") ? changes.title : existing.title;
    const notes = Object.hasOwn(changes, "notes") ? changes.notes : existing.notes;
    const result = owner.userId
        ? await db.prepare("UPDATE workouts SET title = ?, notes = ? WHERE id = ? AND user_id = ?")
            .run(title, notes, id, owner.userId)
        : await db.prepare("UPDATE workouts SET title = ?, notes = ? WHERE id = ? AND guest_id = ?")
            .run(title, notes, id, owner.guestId);
    return result.changes ? ownedWorkout(db, owner, id) : null;
}

function verifyGoogleCredential(credential, fetchImpl = fetch) {
    if (typeof credential !== "string" || credential.length > 10000) {
        fail(400, "VALIDATION_ERROR", "A Google credential is required.");
    }
    return fetchImpl("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential))
        .then(async (response) => {
            if (!response.ok) fail(401, "GOOGLE_TOKEN_INVALID", "Google sign-in could not be verified.");
            const claims = await response.json();
            const issuerOk =
                claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
            const emailVerified = claims.email_verified === true || claims.email_verified === "true";
            if (!issuerOk || claims.aud !== GOOGLE_CLIENT_ID || Number(claims.exp) * 1000 <= Date.now() ||
                !emailVerified || !claims.email) {
                fail(401, "GOOGLE_TOKEN_INVALID", "Google sign-in could not be verified.");
            }
            return claims;
        });
}

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".woff2": "font/woff2"
};

function serveStatic(req, res, publicRoot, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        fail(400, "INVALID_PATH", "The requested path is invalid.");
    }
    const segments = decoded.split("/").filter(Boolean);
    if (segments.some((part) => part.startsWith(".") || ["server", "node_modules", "data"].includes(part))) {
        fail(404, "NOT_FOUND", "The requested page was not found.");
    }
    const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const filePath = path.resolve(publicRoot, relativePath);
    const root = path.resolve(publicRoot);
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
        fail(404, "NOT_FOUND", "The requested page was not found.");
    }
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return false;
    }
    if (!stat.isFile()) return false;
    res.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Content-Length": stat.size,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin"
    });
    if (req.method === "HEAD") {
        res.end();
    } else {
        fs.createReadStream(filePath).pipe(res);
    }
    return true;
}

function createApp(options = {}) {
    const database = options.db || openDatabase(options.dbPath);
    const db = createDatabaseStore(database);
    const publicRoot = options.publicRoot || path.resolve(__dirname, "..");
    const googleVerifier = options.googleVerifier || ((credential) => verifyGoogleCredential(credential));

    async function handler(req, res) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

        try {
            await db.ready;
            const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
            if (!url.pathname.startsWith("/api/")) {
                if (serveStatic(req, res, publicRoot, url.pathname)) return;
                fail(404, "NOT_FOUND", "The requested page was not found.");
            }

            const method = req.method.toUpperCase();
            const route = url.pathname;
            applyApiCors(req, res);
            if (method === "OPTIONS") {
                sendNoContent(res);
                return;
            }
            const exactMethods = {
                "/api/health": ["GET"],
                "/api/auth/me": ["GET"],
                "/api/auth/signup": ["POST"],
                "/api/auth/login": ["POST"],
                "/api/auth/google": ["POST"],
                "/api/auth/logout": ["POST"],
                "/api/auth/profile": ["PATCH"],
                "/api/auth/account": ["DELETE"],
                "/api/admin/users": ["GET"],
                "/api/workouts": ["GET", "POST", "DELETE"],
                "/api/workouts/import": ["POST"]
            };
            if (exactMethods[route] && !exactMethods[route].includes(method)) {
                res.setHeader("Allow", exactMethods[route].join(", "));
                fail(405, "METHOD_NOT_ALLOWED", "Use a supported method for this endpoint.");
            }

            if (route === "/api/health" && method === "GET") {
                sendJson(res, 200, { status: "ok" });
                return;
            }

            if (route === "/api/auth/me" && method === "GET") {
                const session = await findSession(req, db);
                sendJson(res, 200, { user: session?.user_id ? await publicUser(db, session.user_id) : null });
                return;
            }

            if (route === "/api/admin/users" && method === "GET") {
                await requireTeacher(req, db);
                const users = await db.prepare(
                    "SELECT id, name, email, provider, role, created_at AS createdAt FROM users ORDER BY created_at DESC"
                ).all();
                const workoutRows = db.prepare("SELECT * FROM workouts WHERE user_id = ? ORDER BY date DESC");
                const result = await Promise.all(users.map(async (user) => ({
                    ...user,
                    workouts: await Promise.all((await workoutRows.all(user.id)).map((row) => mapWorkout(db, row)))
                })));
                sendJson(res, 200, { users: result });
                return;
            }

            const adminUserMatch = route.match(/^\/api\/admin\/users\/([^/]+)$/);
            if (adminUserMatch) {
                let targetId;
                try {
                    targetId = decodeURIComponent(adminUserMatch[1]);
                } catch {
                    fail(400, "INVALID_ID", "User ID is invalid.");
                }
                if (!targetId || targetId.length > 100) fail(400, "INVALID_ID", "User ID is invalid.");

                const admin = await requireTeacher(req, db);
                if (method === "PATCH") {
                    const changes = validateAdminProfileChanges(await readJson(req));
                    const assignments = [];
                    const params = [];
                    if (Object.hasOwn(changes, "name")) {
                        assignments.push("name = ?");
                        params.push(changes.name);
                    }
                    if (Object.hasOwn(changes, "email")) {
                        assignments.push("email = ?");
                        params.push(changes.email);
                    }
                    params.push(targetId);
                    try {
                        const result = await db.prepare(
                            `UPDATE users SET ${assignments.join(", ")} WHERE id = ?`
                        ).run(...params);
                        if (!result.changes) fail(404, "NOT_FOUND", "User account not found.");
                    } catch (error) {
                        if (isUniqueViolation(error)) {
                            fail(409, "EMAIL_EXISTS", "That email address is already in use.");
                        }
                        throw error;
                    }
                    sendJson(res, 200, { user: await publicUser(db, targetId) });
                    return;
                }

                if (method === "DELETE") {
                    if (targetId === admin.id) {
                        fail(409, "CANNOT_DELETE_SELF", "Use the Account page to manage your own account.");
                    }
                    const result = await db.prepare("DELETE FROM users WHERE id = ?").run(targetId);
                    if (!result.changes) fail(404, "NOT_FOUND", "User account not found.");
                    sendNoContent(res);
                    return;
                }

                res.setHeader("Allow", "PATCH, DELETE");
                fail(405, "METHOD_NOT_ALLOWED", "Use PATCH or DELETE for an admin user action.");
            }

            if (route === "/api/auth/signup" && method === "POST") {
                const body = validateSignup(await readJson(req));
                const { hash, salt } = hashPassword(body.password);
                const id = crypto.randomUUID();
                const createdAt = new Date().toISOString();
                try {
                    await db.prepare(
                        "INSERT INTO users (id, name, email, password_hash, password_salt, provider, created_at) VALUES (?, ?, ?, ?, ?, 'password', ?)"
                    ).run(id, body.name, body.email, hash, salt, createdAt);
                } catch (error) {
                    if (isUniqueViolation(error)) {
                        fail(409, "EMAIL_EXISTS", "An account with this email already exists.");
                    }
                    throw error;
                }
                await activateUserSession(req, res, db, id, 7 * 24 * 60 * 60);
                sendJson(res, 201, { user: await publicUser(db, id) });
                return;
            }

            if (route === "/api/auth/login" && method === "POST") {
                const body = await readJson(req);
                const email = normalizeEmail(body.email);
                if (typeof body.password !== "string" || body.password.length > 128) {
                    fail(400, "VALIDATION_ERROR", "Enter your password.");
                }
                const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(email);
                const matches = user?.password_hash && user?.password_salt
                    ? passwordMatches(body.password, user.password_salt, user.password_hash)
                    : passwordMatches(body.password, "00112233445566778899aabbccddeeff",
                        hashPassword("invalid-password", Buffer.from("00112233445566778899aabbccddeeff", "hex")).hash);
                if (!user || !matches) {
                    fail(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
                }
                const remember = body.remember === true;
                await activateUserSession(
                    req,
                    res,
                    db,
                    user.id,
                    remember ? 7 * 24 * 60 * 60 : 30 * 24 * 60 * 60,
                    remember ? 7 * 24 * 60 * 60 : null
                );
                sendJson(res, 200, { user: await publicUser(db, user.id) });
                return;
            }

            if (route === "/api/auth/google" && method === "POST") {
                const body = await readJson(req);
                const claims = await googleVerifier(body.credential);
                const email = normalizeEmail(claims.email);
                const name = typeof claims.name === "string" && claims.name.trim()
                    ? claims.name.trim().slice(0, 60)
                    : email.split("@")[0].slice(0, 60);
                const picture = typeof claims.picture === "string" &&
                    claims.picture.length <= 2048 && claims.picture.startsWith("https://")
                    ? claims.picture : "";
                let user = await db.prepare("SELECT id FROM users WHERE email = ?").get(email);
                const isNew = !user;
                if (isNew) {
                    const id = crypto.randomUUID();
                    await db.prepare(
                        "INSERT INTO users (id, name, email, provider, picture, created_at) VALUES (?, ?, ?, 'google', ?, ?)"
                    ).run(id, name, email, picture, new Date().toISOString());
                    user = { id };
                } else {
                    await db.prepare("UPDATE users SET picture = ? WHERE id = ?").run(picture, user.id);
                }
                await activateUserSession(req, res, db, user.id, 7 * 24 * 60 * 60);
                sendJson(res, 200, { user: await publicUser(db, user.id), isNew });
                return;
            }

            if (route === "/api/auth/logout" && method === "POST") {
                const session = await findSession(req, db);
                if (session) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
                clearCookie(res, req);
                sendNoContent(res);
                return;
            }

            if (route === "/api/auth/profile" && method === "PATCH") {
                const user = await requireUser(req, db);
                const body = await readJson(req);
                const keys = Object.keys(body);
                const allowed = new Set(["name", "email", "newPassword"]);
                if (keys.some((key) => !allowed.has(key)) || !keys.length) {
                    fail(400, "VALIDATION_ERROR", "Provide name, email, or a new password.");
                }
                const name = body.name === undefined ? user.name : requireString(body.name, "Name", 2, 60);
                const email = body.email === undefined ? user.email : normalizeEmail(body.email);
                let passwordHash;
                let passwordSalt;
                if (body.newPassword !== undefined && body.newPassword !== "") {
                    if (typeof body.newPassword !== "string" || body.newPassword.length < 8 ||
                        body.newPassword.length > 128) {
                        fail(400, "VALIDATION_ERROR", "Password must be between 8 and 128 characters.");
                    }
                    ({ hash: passwordHash, salt: passwordSalt } = hashPassword(body.newPassword));
                }
                try {
                    if (passwordHash) {
                        await db.prepare(
                            "UPDATE users SET name = ?, email = ?, password_hash = ?, password_salt = ? WHERE id = ?"
                        ).run(name, email, passwordHash, passwordSalt, user.id);
                    } else {
                        await db.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?")
                            .run(name, email, user.id);
                    }
                } catch (error) {
                    if (isUniqueViolation(error)) {
                        fail(409, "EMAIL_EXISTS", "That email is already in use.");
                    }
                    throw error;
                }
                sendJson(res, 200, { user: await publicUser(db, user.id) });
                return;
            }

            if (route === "/api/auth/account" && method === "DELETE") {
                const user = await requireUser(req, db);
                await db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
                clearCookie(res, req);
                sendNoContent(res);
                return;
            }

            if (route === "/api/workouts" && method === "GET") {
                const owner = await ownerForWorkouts(req, res, db);
                sendJson(res, 200, { workouts: await getWorkoutList(db, owner) });
                return;
            }

            if (route === "/api/workouts/import" && method === "POST") {
                const owner = await ownerForWorkouts(req, res, db);
                const body = await readJson(req);
                if (!Array.isArray(body.workouts) || body.workouts.length > 500) {
                    fail(400, "VALIDATION_ERROR", "Import must contain a list of at most 500 workouts.");
                }
                const importedCount = await db.transaction(async (tx) => {
                    const imported = [];
                    for (const legacy of body.workouts) {
                        if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
                            fail(400, "VALIDATION_ERROR", "Each imported workout must be an object.");
                        }
                        const legacyId = requireString(legacy.id, "Legacy workout ID", 1, 100);
                        const parsedDate = new Date(legacy.date);
                        if (!Number.isFinite(parsedDate.getTime())) {
                            fail(400, "VALIDATION_ERROR", "Imported workout date is invalid.");
                        }
                        const data = validateWorkout({
                            exercise: legacy.exercise,
                            formScore: legacy.formScore ?? null,
                            repCount: legacy.repCount,
                            rangeOfMotion: legacy.rangeOfMotion ?? null,
                            tempo: legacy.tempo ?? null,
                            reps: legacy.reps || [],
                            title: legacy.title || "",
                            notes: legacy.notes || ""
                        });
                        const before = owner.userId
                            ? await tx.prepare("SELECT id FROM workouts WHERE user_id = ? AND legacy_id = ?")
                                .get(owner.userId, legacyId)
                            : await tx.prepare("SELECT id FROM workouts WHERE guest_id = ? AND legacy_id = ?")
                                .get(owner.guestId, legacyId);
                        const workout = await insertWorkout(tx, owner, data, {
                            legacyId,
                            date: parsedDate.toISOString()
                        });
                        if (!before) imported.push(workout);
                    }
                    return imported.length;
                });
                sendJson(res, 200, { imported: importedCount });
                return;
            }

            if (route === "/api/workouts" && method === "POST") {
                const owner = await ownerForWorkouts(req, res, db);
                const data = validateWorkout(await readJson(req));
                const workout = await db.transaction((tx) => insertWorkout(tx, owner, data));
                sendJson(res, 201, { workout });
                return;
            }

            if (route === "/api/workouts" && method === "DELETE") {
                const owner = await ownerForWorkouts(req, res, db);
                const result = owner.userId
                    ? await db.prepare("DELETE FROM workouts WHERE user_id = ?").run(owner.userId)
                    : await db.prepare("DELETE FROM workouts WHERE guest_id = ?").run(owner.guestId);
                sendJson(res, 200, { deleted: result.changes });
                return;
            }

            const workoutMatch = route.match(/^\/api\/workouts\/([^/]+)$/);
            if (workoutMatch) {
                let id;
                try {
                    id = decodeURIComponent(workoutMatch[1]);
                } catch {
                    fail(400, "INVALID_ID", "Workout ID is invalid.");
                }
                if (!id || id.length > 100) fail(400, "INVALID_ID", "Workout ID is invalid.");
                const owner = await ownerForWorkouts(req, res, db);
                if (method === "GET") {
                    const workout = await ownedWorkout(db, owner, id);
                    if (!workout) fail(404, "NOT_FOUND", "Workout not found.");
                    sendJson(res, 200, { workout });
                    return;
                }
                if (method === "PATCH") {
                    const changes = validateWorkoutChanges(await readJson(req));
                    const workout = await updateOwnedWorkout(db, owner, id, changes);
                    if (!workout) fail(404, "NOT_FOUND", "Workout not found.");
                    sendJson(res, 200, { workout });
                    return;
                }
                if (method === "DELETE") {
                    if (!await removeOwnedWorkout(db, owner, id)) fail(404, "NOT_FOUND", "Workout not found.");
                    sendNoContent(res);
                    return;
                }
                res.setHeader("Allow", "GET, PATCH, DELETE");
                fail(405, "METHOD_NOT_ALLOWED", "Use GET, PATCH, or DELETE for a workout.");
            }

            fail(404, "NOT_FOUND", "API endpoint not found.");
        } catch (error) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            const status = error instanceof HttpError ? error.status : 500;
            const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
            const message = error instanceof HttpError ? error.message : "Something went wrong.";
            if (status >= 500) console.error(error);
            sendJson(res, status, { error: { code, message } });
        }
    }

    return { db: database, store: db, handler };
}

function startServer(options = {}) {
    const app = createApp(options);
    const server = http.createServer(app.handler);
    const port = Number(options.port ?? process.env.PORT ?? 5501);
    const host = options.host || process.env.HOST || "127.0.0.1";
    Promise.resolve(app.store.ready).then(() => server.listen(port, host)).catch((error) => {
        server.emit("error", error);
    });
    return { ...app, server };
}

if (require.main === module) {
    const { server } = startServer();
    server.on("error", (error) => {
        if (error.code === "EADDRINUSE") {
            const port = Number(process.env.PORT || 5501);
            const configuredHost = process.env.HOST || "127.0.0.1";
            const displayHost = configuredHost.includes(":") && !configuredHost.startsWith("[")
                ? `[${configuredHost}]`
                : configuredHost;
            console.error(`Port ${port} is already in use. If FormFit is already running, open http://${displayHost}:${port}/signup.html. Otherwise stop the original server in its terminal with Ctrl+C, then run npm.cmd start once.`);
        } else {
            console.error(error);
        }
        process.exitCode = 1;
    });
    server.on("listening", () => {
        const address = server.address();
        const host = address.address === "::1"
            ? "localhost"
            : address.family === "IPv6" ? `[${address.address}]` : address.address;
        console.log("FormFit is running at http://" + host + ":" + address.port);
    });
}

module.exports = { createApp, startServer };
