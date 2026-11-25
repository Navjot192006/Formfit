"use strict";

const crypto = require("node:crypto");
const readline = require("node:readline");
const { openDatabase, createDatabaseStore } = require("./database.cjs");

const PASSWORD_ITERATIONS = 210000;

function ask(prompt) {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => terminal.question(prompt, (answer) => {
        terminal.close();
        resolve(answer.trim());
    }));
}

function askHidden(prompt) {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== "function") return ask(prompt);

    return new Promise((resolve, reject) => {
        let answer = "";
        process.stdout.write(prompt);
        input.setRawMode(true);
        input.resume();

        const finish = (error) => {
            input.setRawMode(false);
            input.removeListener("data", onData);
            process.stdout.write("\n");
            error ? reject(error) : resolve(answer);
        };

        const onData = (chunk) => {
            for (const char of chunk.toString("utf8")) {
                if (char === "\u0003") return finish(new Error("Cancelled."));
                if (char === "\r" || char === "\n") return finish();
                if (char === "\u007f" || char === "\b") {
                    if (answer) {
                        answer = answer.slice(0, -1);
                        process.stdout.write("\b \b");
                    }
                    continue;
                }
                if (char >= " ") {
                    answer += char;
                    process.stdout.write("*");
                }
            }
        };

        input.on("data", onData);
    });
}

async function main() {
    console.log("Create a teacher account for the read-only project dashboard.\n");
    const name = await ask("Teacher name: ");
    const email = await ask("Teacher email: ");
    const password = await askHidden("Teacher password (8–128 characters): ");

    if (name.length < 2 || name.length > 60) throw new Error("Name must be 2–60 characters.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
    if (password.length < 8 || password.length > 128) throw new Error("Password must be 8–128 characters.");

    const database = openDatabase();
    const db = createDatabaseStore(database);
    try {
        await db.ready;
        const existing = await db.prepare("SELECT id, role FROM users WHERE email = ?").get(email.toLowerCase());
        if (existing) {
            const confirmation = await ask(
                existing.role === "teacher"
                    ? "This teacher account exists. Reset its password and name? Type RESET to continue: "
                    : "This email already has an account. Promote it and reset its password? Type PROMOTE to continue: "
            );
            const expected = existing.role === "teacher" ? "RESET" : "PROMOTE";
            if (confirmation !== expected) throw new Error("No account changes were made.");
        }

        const salt = crypto.randomBytes(16);
        const passwordHash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256").toString("hex");
        const passwordSalt = salt.toString("hex");
        await db.transaction(async (tx) => {
            if (existing) {
                await tx.prepare(
                    "UPDATE users SET name = ?, password_hash = ?, password_salt = ?, provider = 'password', role = 'teacher' WHERE id = ?"
                ).run(name, passwordHash, passwordSalt, existing.id);
            } else {
                await tx.prepare(
                    "INSERT INTO users (id, name, email, password_hash, password_salt, provider, picture, created_at, role) VALUES (?, ?, ?, ?, ?, 'password', '', ?, 'teacher')"
                ).run(crypto.randomUUID(), name, email.toLowerCase(), passwordHash, passwordSalt, new Date().toISOString());
            }
        });
        console.log("Teacher login is ready. Open http://127.0.0.1:5501/login.html and use the email and password you entered.");
        console.log("The password is stored as a hash and is not displayed by the teacher dashboard.");
    } finally {
        await database.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
