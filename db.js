/* FormFit client data layer.
   Workout and account data live in the REST API. Small presentation preferences remain local.
*/

const CURRENT_USER_KEY = "ff_current_user";
const SETTINGS_KEY = "ff_settings";
const API_ROOT = location.port === "5500"
    ? `${location.protocol}//${location.hostname}:5501/api`
    : "/api";

export class ApiError extends Error {
    constructor(message, status = 0, code = "NETWORK_ERROR") {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

async function request(path, options = {}) {
    let response;
    try {
        response = await fetch(API_ROOT + path, {
            credentials: "include",
            ...options,
            headers: {
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...(options.headers || {})
            }
        });
    } catch {
        const message = location.port === "5500"
            ? "Could not reach the FormFit API on port 5501. Keep the API running with `npm.cmd start` in another terminal while using Live Server on port 5500."
            : "Could not reach the FormFit server. In PowerShell, run `npm.cmd start` from the project folder, then open the URL printed by FormFit.";
        throw new ApiError(message);
    }

    if (response.status === 204) return null;
    let payload;
    const responseText = await response.text();
    try {
        payload = responseText ? JSON.parse(responseText) : null;
    } catch {
        const contentType = response.headers.get("content-type") || "unknown content type";
        const looksLikeStaticPage = /text\/html/i.test(contentType)
            || /<\s*!doctype\s+html|<\s*html|Cannot GET \/api\//i.test(responseText.slice(0, 600));
        const message = looksLikeStaticPage
            ? "This page is being served without the FormFit API. In PowerShell, stop the current server, run `npm.cmd start` from the project folder, then open the URL printed by FormFit."
            : `The server returned a non-JSON response (${contentType}, HTTP ${response.status}). Make sure the FormFit API is running at this page's address.`;
        throw new ApiError(message, response.status, "INVALID_RESPONSE");
    }
    if (!response.ok) {
        const rawDetail = payload?.error;
        const detail = rawDetail && typeof rawDetail === "object" ? rawDetail : {};
        const message = detail.message
            || (typeof rawDetail === "string" ? rawDetail : "")
            || payload?.message
            || (response.status === 404
                ? "No FormFit API route was found at this address. In PowerShell, run `npm.cmd start` from the project folder, then open the URL printed by FormFit."
                : "")
            || `The request failed with HTTP ${response.status}. Check that this page is using the FormFit API server.`;
        throw new ApiError(message, response.status, detail.code || payload?.code || "REQUEST_FAILED");
    }
    return payload;
}

function cacheUser(user) {
    try {
        if (user) localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
        else localStorage.removeItem(CURRENT_USER_KEY);
    } catch {
        // The server session remains authoritative when browser storage is unavailable.
    }
}

function readCachedUser() {
    try {
        const value = JSON.parse(localStorage.getItem(CURRENT_USER_KEY));
        return value && typeof value.id === "string" ? value : null;
    } catch {
        return null;
    }
}

async function refreshSession() {
    let user = null;
    try {
        const result = await request("/auth/me");
        user = result.user || null;
        cacheUser(user);
    } catch {
        cacheUser(null);
    }
    try {
        await migrateLegacyWorkouts(user);
    } catch {
        // Keep the current session usable; a later page load retries the import.
    }
}

function getLegacyUser(email) {
    if (!email) return null;
    try {
        const users = JSON.parse(localStorage.getItem("ff_users")) || [];
        return users.find((user) => String(user.email || "").toLowerCase() === email.toLowerCase()) || null;
    } catch {
        return null;
    }
}

async function readLegacyWorkouts(user) {
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return [];
    const databases = await indexedDB.databases();
    if (!databases.some((entry) => entry.name === "formfit-db")) return [];

    const database = await new Promise((resolve, reject) => {
        const opening = indexedDB.open("formfit-db");
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
        opening.onblocked = () => reject(new Error("The old workout database is busy."));
    });
    if (!database.objectStoreNames.contains("workouts")) {
        database.close();
        return [];
    }

    try {
        const records = await new Promise((resolve, reject) => {
            const transaction = database.transaction("workouts", "readonly");
            const reading = transaction.objectStore("workouts").getAll();
            reading.onsuccess = () => resolve(reading.result || []);
            reading.onerror = () => reject(reading.error);
        });
        const legacyUser = getLegacyUser(user?.email);
        const acceptedIds = new Set(["guest"]);
        if (legacyUser?.id) acceptedIds.add(legacyUser.id);
        return records.filter((record) => acceptedIds.has(record.userId));
    } finally {
        database.close();
    }
}

async function migrateLegacyWorkouts(user) {
    const marker = user
        ? "ff_legacy_imported_" + user.id
        : "ff_legacy_guest_imported";
    try {
        if (localStorage.getItem(marker) === "1") return;
    } catch {
        return;
    }

    const records = await readLegacyWorkouts(user);
    for (let index = 0; index < records.length; index += 5) {
        const workouts = records.slice(index, index + 5).map((record) => ({
            id: String(record.id),
            date: record.date,
            title: record.title || "",
            notes: record.notes || "",
            exercise: record.exercise,
            formScore: record.formScore ?? null,
            repCount: record.repCount,
            rangeOfMotion: record.rangeOfMotion ?? null,
            tempo: record.tempo ?? null,
            reps: record.reps || []
        }));
        await request("/workouts/import", {
            method: "POST",
            body: JSON.stringify({ workouts })
        });
    }
    try {
        localStorage.setItem(marker, "1");
    } catch {
        // Re-imports are safe because the API deduplicates by legacy workout ID.
    }
}

await refreshSession();

export function getCurrentUser() {
    return readCachedUser();
}

export function getCurrentUserId() {
    return getCurrentUser()?.id || "guest";
}

export function isLoggedIn() {
    return getCurrentUser() !== null;
}

export async function signup({ name, email, password }) {
    const result = await request("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ name, email, password })
    });
    cacheUser(result.user);
    await migrateLegacyWorkouts(result.user).catch(() => {});
    return result.user;
}

export async function login({ email, password, remember = false }) {
    let result;
    try {
        result = await request("/auth/login", {
            method: "POST",
            body: JSON.stringify({ email, password, remember })
        });
    } catch (error) {
        const legacyUser = getLegacyUser(email.trim());
        if (error.status !== 401 || !legacyUser?.salt || !legacyUser?.hash ||
            !(await verifyLegacyPassword(password, legacyUser))) {
            throw error;
        }
        try {
            result = await request("/auth/signup", {
                method: "POST",
                body: JSON.stringify({ name: legacyUser.name, email, password })
            });
        } catch (migrationError) {
            if (migrationError.code === "EMAIL_EXISTS") throw error;
            throw migrationError;
        }
    }
    cacheUser(result.user);
    await migrateLegacyWorkouts(result.user).catch(() => {});
    return result.user;
}

export async function googleSignIn({ credential }) {
    const result = await request("/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential })
    });
    cacheUser(result.user);
    await migrateLegacyWorkouts(result.user).catch(() => {});
    return { user: result.user, isNew: result.isNew };
}

async function verifyLegacyPassword(password, legacyUser) {
    if (typeof password !== "string" || !globalThis.crypto?.subtle) return false;
    try {
        const salt = Uint8Array.from(
            String(legacyUser.salt).match(/.{2}/g).map((part) => parseInt(part, 16))
        );
        const key = await globalThis.crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(password),
            "PBKDF2",
            false,
            ["deriveBits"]
        );
        const derived = await globalThis.crypto.subtle.deriveBits(
            { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
            key,
            256
        );
        const actual = [...new Uint8Array(derived)]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("");
        return actual === legacyUser.hash;
    } catch {
        return false;
    }
}

export async function logout() {
    await request("/auth/logout", { method: "POST" });
    cacheUser(null);
}

export async function updateProfile({ name, email, newPassword }) {
    const result = await request("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ name, email, newPassword })
    });
    cacheUser(result.user);
    return result.user;
}

export async function deleteAccount() {
    await request("/auth/account", { method: "DELETE" });
    cacheUser(null);
}

export async function createWorkout(data) {
    const result = await request("/workouts", {
        method: "POST",
        body: JSON.stringify(data)
    });
    return result.workout;
}

export async function getWorkouts(_userId) {
    const result = await request("/workouts");
    return result.workouts;
}

export async function getTeacherUsers() {
    const result = await request("/admin/users");
    return result.users;
}

export async function updateTeacherUser(id, changes) {
    const result = await request("/admin/users/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(changes)
    });
    if (result.user?.id === getCurrentUser()?.id) cacheUser(result.user);
    return result.user;
}

export async function deleteTeacherUser(id) {
    await request("/admin/users/" + encodeURIComponent(id), { method: "DELETE" });
}

export async function getWorkout(id) {
    const result = await request("/workouts/" + encodeURIComponent(id));
    return result.workout;
}

export async function updateWorkout(id, changes) {
    const result = await request("/workouts/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(changes)
    });
    return result.workout;
}

export async function deleteWorkout(id) {
    await request("/workouts/" + encodeURIComponent(id), { method: "DELETE" });
}

export async function deleteAllWorkouts() {
    const result = await request("/workouts", { method: "DELETE" });
    return result.deleted;
}

const round = (v, d = 1) =>
    Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;

export function buildWorkoutRecord({ exercise = "squat", summary = {}, reps = [] }) {
    return {
        exercise,
        formScore: round(summary.formScore),
        repCount: Number.isFinite(summary.repCount) ? summary.repCount : reps.length,
        rangeOfMotion: round(summary.rangeOfMotion),
        tempo: round(summary.tempo),
        reps: reps.map(r => {
            const conf =
                Number.isFinite(r.overallConfidence) ? r.overallConfidence
                    : Number.isFinite(r.confidence) ? r.confidence
                        : Number.isFinite(r.confidence?.overall) ? r.confidence.overall * 100
                            : null;

            return {
                repNumber: r.repNumber,
                formScore: round(r.formScore),
                rangeOfMotion: round(r.rangeOfMotion ?? r.rom),
                duration: round(r.duration, 2),
                confidence: round(conf, 0),
                side: r.primarySide ?? r.side ?? null,

                depthScore: round(r.depthScore),
                hipScore: round(r.hipScore),
                torsoScore: round(r.torsoScore ?? r.torso?.score),
                bottomStabilityScore: round(r.bottomStabilityScore),
                kneeAngle: round(r.primaryKneeAngle),
                hipAngle: round(r.primaryHipAngle),
                torsoAngle: round(r.torsoAngle),

                elbowStabilityScore: round(r.elbowStability?.score),
                romScore: round(r.totalRom?.score),
                tempoScore: round(r.tempo?.score),
                topAngle: round(r.topAngle ?? r.topElbowAngle),
                bottomAngle: round(r.bottomAngle ?? r.bottomElbowAngle),

                feedback: Array.isArray(r.feedback) ? r.feedback : []
            };
        })
    };
}

export function getSetting(key, fallback = null) {
    try {
        const all = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
        return key in all ? all[key] : fallback;
    } catch {
        return fallback;
    }
}

export function setSetting(key, value) {
    let all = {};
    try {
        all = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
        // Start with empty settings if storage was cleared or corrupted.
    }
    all[key] = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(all));
}
