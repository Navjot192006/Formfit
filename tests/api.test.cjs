"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp } = require("../server/app.cjs");

class ApiClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.cookie = "";
    }

    async send(route, options = {}) {
        const headers = {};
        if (this.cookie) headers.cookie = this.cookie;
        if (options.body !== undefined) headers["content-type"] = "application/json";
        if (options.origin !== false) headers.origin = options.origin || this.baseUrl;
        const response = await fetch(this.baseUrl + route, {
            method: options.method || "GET",
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) this.cookie = setCookie.split(";")[0];
        const text = await response.text();
        const isJson = String(response.headers.get("content-type") || "").includes("application/json");
        return {
            response,
            payload: text ? (isJson ? JSON.parse(text) : text) : null
        };
    }

    async signup(email, name = "Test User", password = "Valid-pass-123") {
        return this.send("/api/auth/signup", {
            method: "POST",
            body: { name, email, password }
        });
    }

    async createWorkout(body) {
        return this.send("/api/workouts", { method: "POST", body });
    }
}

async function withServer(t, options = {}) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "formfit-api-"));
    const app = createApp({
        dbPath: path.join(folder, "test.sqlite"),
        googleVerifier: options.googleVerifier
    });
    const server = http.createServer(app.handler);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const client = new ApiClient("http://127.0.0.1:" + address.port);

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        app.db.close();
        fs.rmSync(folder, { recursive: true, force: true });
    });
    return { app, client, baseUrl: client.baseUrl };
}

function sampleWorkout(extra = {}) {
    return {
        exercise: "squat",
        formScore: 88.5,
        repCount: 1,
        rangeOfMotion: 82,
        tempo: 2.4,
        reps: [{
            repNumber: 1,
            formScore: 88.5,
            rangeOfMotion: 82,
            duration: 2.4,
            confidence: 97,
            side: "left",
            depthScore: 92,
            feedback: ["Good depth"]
        }],
        title: "Leg session",
        notes: "Felt steady",
        ...extra
    };
}

test("workout CRUD persists summaries and normalized rep details", async (t) => {
    const { app, client } = await withServer(t);
    const created = await client.createWorkout(sampleWorkout());
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.workout.exercise, "squat");
    assert.equal(created.payload.workout.reps[0].feedback[0], "Good depth");
    assert.equal(created.payload.workout.reps[0].confidence, 97);
    assert.equal(app.db.prepare("SELECT confidence FROM workout_reps WHERE workout_id = ?")
        .get(created.payload.workout.id).confidence, 97);
    assert.ok(created.payload.workout.id);

    const listed = await client.send("/api/workouts");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.workouts.length, 1);

    const fetched = await client.send("/api/workouts/" + created.payload.workout.id);
    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.payload.workout.title, "Leg session");

    const updated = await client.send("/api/workouts/" + created.payload.workout.id, {
        method: "PATCH",
        body: { title: "Updated leg session", notes: "New note" }
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.workout.title, "Updated leg session");
    assert.equal(updated.payload.workout.notes, "New note");

    const deleted = await client.send("/api/workouts/" + created.payload.workout.id, {
        method: "DELETE"
    });
    assert.equal(deleted.response.status, 204);
    const missing = await client.send("/api/workouts/" + created.payload.workout.id);
    assert.equal(missing.response.status, 404);
});

test("guest workouts become account workouts at signup", async (t) => {
    const { client } = await withServer(t);
    const created = await client.createWorkout(sampleWorkout());
    assert.equal(created.response.status, 201);

    const signedUp = await client.signup("guest@example.test");
    assert.equal(signedUp.response.status, 201);
    const listed = await client.send("/api/workouts");
    assert.equal(listed.payload.workouts.length, 1);
    assert.equal(listed.payload.workouts[0].id, created.payload.workout.id);
    assert.equal(listed.payload.workouts[0].userId, signedUp.payload.user.id);
});

test("legacy workout imports preserve dates and are idempotent", async (t) => {
    const { client } = await withServer(t);
    const oldWorkout = {
        id: "legacy-session-1",
        userId: "guest",
        date: "2025-01-02T10:30:00.000Z",
        ...sampleWorkout()
    };
    const firstImport = await client.send("/api/workouts/import", {
        method: "POST",
        body: { workouts: [oldWorkout] }
    });
    assert.equal(firstImport.response.status, 200);
    assert.equal(firstImport.payload.imported, 1);

    const duplicateImport = await client.send("/api/workouts/import", {
        method: "POST",
        body: { workouts: [oldWorkout] }
    });
    assert.equal(duplicateImport.payload.imported, 0);
    const history = await client.send("/api/workouts");
    assert.equal(history.payload.workouts.length, 1);
    assert.equal(history.payload.workouts[0].date, oldWorkout.date);
});

test("account sessions are HttpOnly and workout ownership is enforced", async (t) => {
    const { baseUrl, client: first } = await withServer(t);
    const signup = await first.signup("first@example.test");
    const cookie = signup.response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const created = await first.createWorkout(sampleWorkout());

    const second = new ApiClient(baseUrl);
    const secondSignup = await second.signup("second@example.test");
    assert.equal(secondSignup.response.status, 201);
    assert.equal((await second.send("/api/workouts")).payload.workouts.length, 0);
    assert.equal(
        (await second.send("/api/workouts/" + created.payload.workout.id)).response.status,
        404
    );
    assert.equal(
        (await second.send("/api/workouts/" + created.payload.workout.id, { method: "DELETE" })).response.status,
        404
    );
});

test("server validation rejects malformed data and keeps SQL-like text as data", async (t) => {
    const { client } = await withServer(t);
    const invalid = await client.createWorkout(sampleWorkout({ formScore: 101 }));
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.error.code, "VALIDATION_ERROR");

    const injectedText = "notes'); DROP TABLE users; --";
    const created = await client.createWorkout(sampleWorkout({ notes: injectedText }));
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.workout.notes, injectedText);
    assert.equal((await client.send("/api/health")).payload.status, "ok");

    const invalidRep = await client.createWorkout(sampleWorkout({
        reps: [{ repNumber: 1, confidence: 101 }]
    }));
    assert.equal(invalidRep.response.status, 400);

    const wrongMethod = await client.send("/api/workouts", { method: "PATCH", body: {} });
    assert.equal(wrongMethod.response.status, 405);
    assert.equal(wrongMethod.response.headers.get("allow"), "GET, POST, DELETE");
});

test("auth rejects invalid credentials, protects profile routes, and deletes account data", async (t) => {
    const { app, baseUrl } = await withServer(t);
    const client = new ApiClient(baseUrl);
    assert.equal((await client.send("/api/auth/profile", {
        method: "PATCH",
        body: { name: "No session" }
    })).response.status, 401);

    const signup = await client.signup("auth@example.test");
    assert.equal(signup.response.status, 201);
    assert.equal((await client.createWorkout(sampleWorkout())).response.status, 201);
    const duplicate = await client.signup("AUTH@example.test");
    assert.equal(duplicate.response.status, 409);

    const wrongPassword = await new ApiClient(baseUrl).send("/api/auth/login", {
        method: "POST",
        body: { email: "auth@example.test", password: "wrong-password" }
    });
    assert.equal(wrongPassword.response.status, 401);
    assert.equal(wrongPassword.payload.error.code, "INVALID_CREDENTIALS");

    const deleted = await client.send("/api/auth/account", { method: "DELETE" });
    assert.equal(deleted.response.status, 204);
    assert.match(deleted.response.headers.get("set-cookie"), /Max-Age=0/i);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM workouts WHERE user_id = ?")
        .get(signup.payload.user.id).count, 0);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
        .get(signup.payload.user.id).count, 0);
    assert.equal(
        await appWorkoutCountFromNoLongerOwnedAccount(client),
        true
    );
});

async function appWorkoutCountFromNoLongerOwnedAccount(client) {
    const response = await client.send("/api/workouts");
    return response.response.status === 200 && response.payload.workouts.length === 0;
}

test("login restores the server session and profile updates validate fields", async (t) => {
    const { baseUrl } = await withServer(t);
    const owner = new ApiClient(baseUrl);
    await owner.signup("login@example.test");
    await owner.send("/api/auth/logout", { method: "POST" });

    const login = await owner.send("/api/auth/login", {
        method: "POST",
        body: { email: "login@example.test", password: "Valid-pass-123", remember: true }
    });
    assert.equal(login.response.status, 200);
    assert.match(login.response.headers.get("set-cookie"), /Max-Age=604800/i);
    await owner.send("/api/auth/logout", { method: "POST" });
    const sessionLogin = await owner.send("/api/auth/login", {
        method: "POST",
        body: { email: "login@example.test", password: "Valid-pass-123", remember: false }
    });
    assert.equal(sessionLogin.response.status, 200);
    assert.doesNotMatch(sessionLogin.response.headers.get("set-cookie"), /Max-Age=/i);
    const profile = await owner.send("/api/auth/profile", {
        method: "PATCH",
        body: { name: "Updated Name" }
    });
    assert.equal(profile.payload.user.name, "Updated Name");
    const badProfile = await owner.send("/api/auth/profile", {
        method: "PATCH",
        body: { name: "x" }
    });
    assert.equal(badProfile.response.status, 400);
});

test("foreign origins cannot make state-changing requests", async (t) => {
    const { client } = await withServer(t);
    const response = await client.send("/api/workouts", {
        method: "POST",
        origin: "https://attacker.example",
        body: sampleWorkout()
    });
    assert.equal(response.response.status, 403);
    assert.equal(response.payload.error.code, "ORIGIN_DENIED");
});

test("Google credentials are delegated to server verification and static paths are restricted", async (t) => {
    const { client } = await withServer(t, {
        googleVerifier: async (credential) => {
            assert.equal(credential, "verified-by-test");
            return {
                iss: "https://accounts.google.com",
                aud: "test-client",
                exp: String(Date.now() / 1000 + 60),
                email_verified: "true",
                email: "google@example.test",
                name: "Google User"
            };
        }
    });
    const google = await client.send("/api/auth/google", {
        method: "POST",
        body: { credential: "verified-by-test" }
    });
    assert.equal(google.response.status, 200);
    assert.equal(google.payload.user.email, "google@example.test");

    const homepage = await client.send("/");
    assert.equal(homepage.response.status, 200);
    assert.match(homepage.response.headers.get("content-type"), /text\/html/i);
    const source = await client.send("/server/database.cjs");
    assert.equal(source.response.status, 404);
});
