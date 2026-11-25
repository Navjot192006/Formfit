import { deleteTeacherUser, getCurrentUser, getTeacherUsers, updateTeacherUser } from "./db.js";

const $ = (id) => document.getElementById(id);
const status = $("teacherStatus");
const content = $("teacherContent");
const search = $("teacherSearch");
const usersElement = $("teacherUsers");
const editDialog = $("teacherEditDialog");
const editForm = $("teacherEditForm");
let allUsers = [];
let signedInTeacherId = null;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const prettyDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
};

function displayValue(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
    return String(value);
}

const repFields = [
    ["Form score", "formScore"], ["Range of motion", "rangeOfMotion", "°"],
    ["Duration", "duration", "s"], ["Confidence", "confidence", "%"], ["Side", "side"],
    ["Depth score", "depthScore"], ["Hip score", "hipScore"], ["Torso score", "torsoScore"],
    ["Bottom stability", "bottomStabilityScore"], ["Knee angle", "kneeAngle", "°"],
    ["Hip angle", "hipAngle", "°"], ["Torso angle", "torsoAngle", "°"],
    ["Elbow stability", "elbowStabilityScore"], ["ROM score", "romScore"],
    ["Tempo score", "tempoScore"], ["Top angle", "topAngle", "°"],
    ["Bottom angle", "bottomAngle", "°"]
];

function renderRep(rep) {
    const values = repFields.map(([label, key, suffix = ""]) =>
        `<div><dt>${label}</dt><dd>${escapeHtml(displayValue(rep[key]))}${rep[key] != null && rep[key] !== "" ? suffix : ""}</dd></div>`
    ).join("");
    const feedback = Array.isArray(rep.feedback) && rep.feedback.length
        ? `<ul>${rep.feedback.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
        : "<p>No feedback recorded.</p>";
    return `<details class="teacher-rep"><summary>Rep ${escapeHtml(rep.repNumber)} · ${escapeHtml(displayValue(rep.formScore))} score</summary><dl>${values}</dl><div class="teacher-feedback"><b>Feedback</b>${feedback}</div></details>`;
}

function renderWorkout(workout) {
    const exercise = workout.exercise === "bicep-curl" ? "Bicep curl" : "Squat";
    const reps = Array.isArray(workout.reps) ? workout.reps : [];
    const note = workout.notes ? `<p class="teacher-workout-note">${escapeHtml(workout.notes)}</p>` : "";
    const repDetails = reps.length
        ? `<details class="teacher-reps"><summary>View ${reps.length} rep measurement${reps.length === 1 ? "" : "s"}</summary>${reps.map(renderRep).join("")}</details>`
        : `<p class="teacher-no-reps">No individual rep measurements were saved.</p>`;
    return `<article class="teacher-workout">
        <div class="teacher-workout-head"><div><span class="teacher-chip">${exercise}</span><h4>${escapeHtml(workout.title || `${exercise} session`)}</h4><p>${escapeHtml(prettyDate(workout.date))}</p></div><strong class="teacher-score">${escapeHtml(displayValue(workout.formScore))}<small>score</small></strong></div>
        <dl class="teacher-workout-metrics"><div><dt>Reps</dt><dd>${escapeHtml(displayValue(workout.repCount))}</dd></div><div><dt>Average range</dt><dd>${escapeHtml(displayValue(workout.rangeOfMotion))}${workout.rangeOfMotion != null ? "°" : ""}</dd></div><div><dt>Average tempo</dt><dd>${escapeHtml(displayValue(workout.tempo))}${workout.tempo != null ? "s" : ""}</dd></div></dl>
        ${note}${repDetails}
    </article>`;
}

function renderUser(user) {
    const workouts = Array.isArray(user.workouts) ? user.workouts : [];
    const ownAccount = user.id === signedInTeacherId;
    const workoutContent = workouts.length
        ? workouts.map(renderWorkout).join("")
        : "<p class=\"teacher-no-workouts\">This account has no saved workouts yet.</p>";
    return `<details class="teacher-user">
        <summary><span class="teacher-avatar" aria-hidden="true">${escapeHtml(user.name?.charAt(0)?.toUpperCase() || "U")}</span><span class="teacher-user-main"><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></span><span class="teacher-user-count">${workouts.length} workout${workouts.length === 1 ? "" : "s"}</span></summary>
        <div class="teacher-user-body">
            <div class="teacher-user-actions">
                <button class="teacher-action-button" type="button" data-user-action="edit" data-user-id="${escapeHtml(user.id)}">Edit profile</button>
                ${ownAccount
                    ? "<span class=\"teacher-admin-note\">Your signed-in admin account is protected from deletion here.</span>"
                    : `<button class="teacher-action-button teacher-action-danger" type="button" data-user-action="delete" data-user-id="${escapeHtml(user.id)}">Delete account</button>`}
            </div>
            <dl class="teacher-account-data"><div><dt>User ID</dt><dd>${escapeHtml(user.id)}</dd></div><div><dt>Account type</dt><dd>${escapeHtml(user.provider)}</dd></div><div><dt>Role</dt><dd>${escapeHtml(user.role)}</dd></div><div><dt>Created</dt><dd>${escapeHtml(prettyDate(user.createdAt))}</dd></div></dl><h3>Saved workout records</h3>${workoutContent}
        </div>
    </details>`;
}

function updateSummary() {
    const workouts = allUsers.flatMap((item) => item.workouts || []);
    const repCount = workouts.reduce((sum, workout) => sum + (workout.reps?.length || 0), 0);
    $("teacherUserCount").textContent = String(allUsers.length);
    $("teacherWorkoutCount").textContent = String(workouts.length);
    $("teacherRepCount").textContent = String(repCount);
}

function render() {
    const query = search.value.trim().toLowerCase();
    const filtered = allUsers.filter((user) => `${user.name} ${user.email}`.toLowerCase().includes(query));
    usersElement.innerHTML = filtered.map(renderUser).join("");
    const noResults = $("teacherNoResults");
    noResults.hidden = filtered.length > 0;
    noResults.textContent = allUsers.length === 0 && !query
        ? "No registered user accounts are in the database yet."
        : "No registered users match this search.";
}

function showActionStatus(message, isError = false) {
    const actionStatus = $("teacherActionStatus");
    actionStatus.textContent = message;
    actionStatus.classList.toggle("is-error", isError);
}

function openEditDialog(user) {
    $("teacherEditId").value = user.id;
    $("teacherEditName").value = user.name || "";
    $("teacherEditEmail").value = user.email || "";
    $("teacherEditError").hidden = true;
    $("teacherEditError").textContent = "";
    editDialog.showModal();
    $("teacherEditName").focus();
}

search.addEventListener("input", render);

$("teacherEditCancel").addEventListener("click", () => editDialog.close());

editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saveButton = editForm.querySelector('button[type="submit"]');
    const errorElement = $("teacherEditError");
    const userId = $("teacherEditId").value;
    saveButton.disabled = true;
    errorElement.hidden = true;
    try {
        const updatedUser = await updateTeacherUser(userId, {
            name: $("teacherEditName").value.trim(),
            email: $("teacherEditEmail").value.trim()
        });
        allUsers = allUsers.map((user) => user.id === updatedUser.id
            ? { ...user, ...updatedUser }
            : user);
        editDialog.close();
        updateSummary();
        render();
        showActionStatus(`Updated ${updatedUser.name}'s profile.`);
    } catch (error) {
        errorElement.textContent = error.message || "The profile could not be updated.";
        errorElement.hidden = false;
    } finally {
        saveButton.disabled = false;
    }
});

usersElement.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-user-action]");
    if (!button || !usersElement.contains(button)) return;
    const user = allUsers.find((item) => item.id === button.dataset.userId);
    if (!user) return;

    if (button.dataset.userAction === "edit") {
        openEditDialog(user);
        return;
    }
    if (button.dataset.userAction !== "delete") return;

    const confirmed = window.confirm(
        `Delete ${user.name} (${user.email})? This permanently deletes the account, its sessions, and all saved workouts.`
    );
    if (!confirmed) return;

    button.disabled = true;
    showActionStatus(`Deleting ${user.name}'s account…`);
    try {
        await deleteTeacherUser(user.id);
        allUsers = allUsers.filter((item) => item.id !== user.id);
        updateSummary();
        render();
        showActionStatus(`Deleted ${user.name}'s account and associated workout data.`);
    } catch (error) {
        showActionStatus(error.message || "The account could not be deleted.", true);
        button.disabled = false;
    }
});

async function load() {
    const user = getCurrentUser();
    if (!user) {
        status.textContent = "Log in with the teacher account to manage project accounts.";
        return;
    }
    if (user.role !== "teacher") {
        status.textContent = "Teacher admin access is required. Sign in with the teacher account.";
        return;
    }

    try {
        signedInTeacherId = user.id;
        allUsers = await getTeacherUsers();
        updateSummary();
        content.hidden = false;
        status.hidden = true;
        render();
    } catch (error) {
        status.textContent = error.status === 403 || error.status === 401
            ? "Teacher admin access is required. Sign in with the teacher account."
            : `Could not load database records. ${error.message}`;
    }
}

load();
