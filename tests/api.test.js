const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createServer } = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const createApp = require("../server");

let server;
let app;
let baseUrl;
let databasePath;
let tempDirectory;

async function patchBug(id, resource, body, approvalToken) {
    const headers = { "Content-Type": "application/json" };
    if (approvalToken) {
        headers.Authorization = `Bearer ${approvalToken}`;
    }
    return fetch(`${baseUrl}/api/bugs/${id}/${resource}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body)
    });
}

async function createBug(title, description = `${title} description`) {
    const response = await fetch(`${baseUrl}/api/bugs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description })
    });
    return { response, bug: await response.json() };
}

before(async () => {
    tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "campusops-tests-"));
    databasePath = path.join(tempDirectory, "test.sqlite");
    app = createApp({ databasePath, approvalToken: "test-approval-token", outboxToken: "test-outbox-token" });
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    app.locals.closeDatabase();
    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
});

test("the database file is created automatically", () => {
    assert.equal(fs.existsSync(databasePath), true);
});

test("the application connection enforces foreign keys without integrity violations", () => {
    assert.equal(app.locals.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.deepEqual(app.locals.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("the application connection rejects an orphan outbox event", () => {
    assert.throws(() => {
        app.locals.database.prepare(`
            INSERT INTO outbox (eventType, bugId, payload, createdAt)
            VALUES (?, ?, ?, ?)
        `).run("bug.created", 999999, "{}", new Date().toISOString());
    }, /FOREIGN KEY constraint failed/);
});

test("GET /api/health reports the service status", async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        status: "online",
        project: "CampusOps"
    });
});

test("GET /api/bugs initially returns an empty list", async () => {
    const response = await fetch(`${baseUrl}/api/bugs`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
});

test("POST /api/bugs creates and returns a normalized report", async () => {
    const response = await fetch(`${baseUrl}/api/bugs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "  Broken login  ", description: "  Button does nothing.  " })
    });
    const bug = await response.json();

    assert.equal(response.status, 201);
    assert.equal(bug.id, 1);
    assert.equal(bug.title, "Broken login");
    assert.equal(bug.description, "Button does nothing.");
    assert.equal(bug.status, "Reported");
    assert.equal(bug.severity, "Medium");
    assert.ok(Number.isNaN(Date.parse(bug.createdAt)) === false);

    const listResponse = await fetch(`${baseUrl}/api/bugs`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [bug]);
});

test("bug creation persists a matching pending outbox event", async () => {
    const { response, bug } = await createBug("Outbox persistence", "Persist this event too");
    assert.equal(response.status, 201);
    const pending = await fetch(`${baseUrl}/api/outbox/pending`, {
        headers: { Authorization: "Bearer test-outbox-token" }
    });
    const events = await pending.json();
    const event = events.find((item) => item.bugId === bug.id);
    assert.equal(pending.status, 200);
    assert.ok(event);
    assert.equal(event.eventType, "bug.created");
    assert.deepEqual(event.payload, bug);
    assert.equal(event.createdAt, bug.createdAt);
});

test("outbox endpoints require their dedicated bearer token", async () => {
    for (const authorization of [undefined, "Bearer wrong-token"]) {
        const headers = authorization ? { Authorization: authorization } : {};
        const response = await fetch(`${baseUrl}/api/outbox/pending`, { headers });
        assert.equal(response.status, 403);
    }
});

test("outbox acknowledgements persist once and disappear from pending events", async () => {
    const { bug } = await createBug("Acknowledgement report");
    const pendingResponse = await fetch(`${baseUrl}/api/outbox/pending`, {
        headers: { Authorization: "Bearer test-outbox-token" }
    });
    const event = (await pendingResponse.json()).find((item) => item.bugId === bug.id);
    const headers = { Authorization: "Bearer test-outbox-token" };
    const unauthorized = await fetch(`${baseUrl}/api/outbox/${event.id}/ack`, { method: "POST" });
    assert.equal(unauthorized.status, 403);
    const first = await fetch(`${baseUrl}/api/outbox/${event.id}/ack`, { method: "POST", headers });
    assert.equal(first.status, 200);
    assert.ok(Number.isNaN(Date.parse((await first.json()).acknowledgedAt)) === false);

    const duplicate = await fetch(`${baseUrl}/api/outbox/${event.id}/ack`, { method: "POST", headers });
    assert.equal(duplicate.status, 409);
    const pendingAgain = await fetch(`${baseUrl}/api/outbox/pending`, { headers });
    assert.equal((await pendingAgain.json()).some((item) => item.id === event.id), false);
});

test("bug and outbox writes roll back together when outbox persistence fails", async () => {
    const failurePath = path.join(tempDirectory, "outbox-failure.sqlite");
    const failureApp = createApp({ databasePath: failurePath });
    const failureDatabase = new DatabaseSync(failurePath);
    failureDatabase.exec("PRAGMA foreign_keys = ON");
    failureDatabase.exec(`
        CREATE TRIGGER fail_outbox_insert BEFORE INSERT ON outbox
        BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END
    `);
    failureDatabase.close();
    const failureServer = createServer(failureApp);
    await new Promise((resolve) => failureServer.listen(0, "127.0.0.1", resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${failureServer.address().port}/api/bugs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Must roll back", description: "The event cannot be saved" })
        });
        assert.equal(response.status, 500);
        const bugs = await fetch(`http://127.0.0.1:${failureServer.address().port}/api/bugs`);
        assert.deepEqual(await bugs.json(), []);
    } finally {
        await new Promise((resolve, reject) => {
            failureServer.close((error) => error ? reject(error) : resolve());
        });
        failureApp.locals.closeDatabase();
    }
});

test("outbox endpoints fail closed when no outbox token is configured", async () => {
    const noTokenPath = path.join(tempDirectory, "no-outbox-token.sqlite");
    const noTokenApp = createApp({ databasePath: noTokenPath });
    const noTokenServer = createServer(noTokenApp);
    await new Promise((resolve) => noTokenServer.listen(0, "127.0.0.1", resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${noTokenServer.address().port}/api/outbox/pending`);
        assert.equal(response.status, 503);
    } finally {
        await new Promise((resolve, reject) => {
            noTokenServer.close((error) => error ? reject(error) : resolve());
        });
        noTokenApp.locals.closeDatabase();
    }
});

for (const field of ["title", "description"]) {
    test(`POST /api/bugs rejects a missing ${field}`, async () => {
        const body = { title: "Title", description: "Description" };
        delete body[field];

        const response = await fetch(`${baseUrl}/api/bugs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
            message: "Title and description are required."
        });
    });

    test(`POST /api/bugs rejects a whitespace-only ${field}`, async () => {
        const body = { title: "Title", description: "Description" };
        body[field] = " \t\n ";

        const response = await fetch(`${baseUrl}/api/bugs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
            message: "Title and description are required."
        });
    });

    test(`POST /api/bugs rejects a non-string ${field}`, async () => {
        const body = { title: "Title", description: "Description" };
        body[field] = { invalid: true };

        const response = await fetch(`${baseUrl}/api/bugs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
            message: "Title and description are required."
        });
    });
}

for (const body of ["null", "[]", '"text"', "42"]) {
    test(`POST /api/bugs rejects a non-object JSON body (${body})`, async () => {
        const response = await fetch(`${baseUrl}/api/bugs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body
        });

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
            message: "Title and description are required."
        });
    });
}

test("POST /api/bugs rejects a request without JSON content type", async () => {
    const response = await fetch(`${baseUrl}/api/bugs`, {
        method: "POST",
        body: JSON.stringify({ title: "Title", description: "Description" })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        message: "Title and description are required."
    });
});

test("legacy pending-triage severity is migrated to Medium", async () => {
    const legacyPath = path.join(tempDirectory, "legacy.sqlite");
    const legacyDatabase = new DatabaseSync(legacyPath);
    legacyDatabase.exec("PRAGMA foreign_keys = ON");
    legacyDatabase.exec(`
        CREATE TABLE bugs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL,
            severity TEXT NOT NULL,
            createdAt TEXT NOT NULL
        )
    `);
    legacyDatabase.prepare(`
        INSERT INTO bugs (title, description, status, severity, createdAt)
        VALUES (?, ?, ?, ?, ?)
    `).run("Legacy report", "Old record", "Reported", "Pending triage", "2025-01-01T00:00:00.000Z");
    legacyDatabase.close();

    const legacyApp = createApp({ databasePath: legacyPath });
    const legacyServer = createServer(legacyApp);
    await new Promise((resolve) => legacyServer.listen(0, "127.0.0.1", resolve));

    try {
        const response = await fetch(`http://127.0.0.1:${legacyServer.address().port}/api/bugs`);
        const bugs = await response.json();
        assert.equal(response.status, 200);
        assert.equal(bugs[0].severity, "Medium");
    } finally {
        await new Promise((resolve, reject) => {
            legacyServer.close((error) => error ? reject(error) : resolve());
        });
        legacyApp.locals.closeDatabase();
    }
});

test("PATCH /api/bugs/:id/severity accepts each allowed severity and persists it", async () => {
    for (const severity of ["Critical", "High", "Medium", "Low"]) {
        const response = await patchBug(1, "severity", { severity });
        const bug = await response.json();
        assert.equal(response.status, 200);
        assert.equal(bug.severity, severity);
    }

    const invalid = await patchBug(1, "severity", { severity: "Urgent" });
    assert.equal(invalid.status, 400);
});

test("PATCH /api/bugs/:id/status rejects invalid IDs, payloads, statuses and missing bugs", async () => {
    const invalidId = await patchBug("abc", "status", { status: "Triaged" });
    assert.equal(invalidId.status, 400);
    const decimalId = await patchBug("1.0", "status", { status: "Triaged" });
    assert.equal(decimalId.status, 400);

    const invalidStatus = await patchBug(1, "status", { status: "Done" });
    assert.equal(invalidStatus.status, 400);

    const missingStatus = await patchBug(1, "status", {});
    assert.equal(missingStatus.status, 400);

    const missingBug = await patchBug(999, "status", { status: "Triaged" });
    assert.equal(missingBug.status, 404);

    const skippedStage = await patchBug(1, "status", { status: "Human Approval" });
    assert.equal(skippedStage.status, 409);
});

test("status lifecycle requires triage, development, QA and human approval", async () => {
    for (const status of [
        "Triaged",
        "In Development",
        "QA Review",
        "In Development",
        "QA Review",
        "Human Approval"
    ]) {
        const response = await patchBug(1, "status", { status });
        const bug = await response.json();
        assert.equal(response.status, 200);
        assert.equal(bug.status, status);
    }

    const missingApproval = await patchBug(1, "status", { status: "Approved" });
    assert.equal(missingApproval.status, 403);

    const invalidApproval = await patchBug(1, "status", { status: "Approved" }, "wrong-token");
    assert.equal(invalidApproval.status, 403);

    const approved = await patchBug(1, "status", { status: "Approved" }, "test-approval-token");
    const bug = await approved.json();
    assert.equal(approved.status, 200);
    assert.equal(bug.status, "Approved");

    const terminal = await patchBug(1, "status", { status: "Rejected" });
    assert.equal(terminal.status, 409);
});

test("a bug can be rejected only after reaching Human Approval", async () => {
    const { response: createResponse, bug } = await createBug("Rejectable report");
    assert.equal(createResponse.status, 201);

    for (const status of ["Triaged", "In Development", "QA Review", "Human Approval", "Rejected"]) {
        const token = status === "Rejected" ? "test-approval-token" : undefined;
        const response = await patchBug(bug.id, "status", { status }, token);
        const updatedBug = await response.json();
        assert.equal(response.status, 200);
        assert.equal(updatedBug.status, status);
    }
});

test("terminal status changes fail closed when no approval token is configured", async () => {
    const noTokenPath = path.join(tempDirectory, "no-approval-token.sqlite");
    const noTokenApp = createApp({ databasePath: noTokenPath, approvalToken: "" });
    const database = new DatabaseSync(noTokenPath);
    database.exec("PRAGMA foreign_keys = ON");
    database.prepare(`
        INSERT INTO bugs (title, description, status, severity, createdAt)
        VALUES (?, ?, ?, ?, ?)
    `).run("Awaiting approval", "Needs a human decision", "Human Approval", "Medium", "2025-01-01T00:00:00.000Z");
    database.close();

    const noTokenServer = createServer(noTokenApp);
    await new Promise((resolve) => noTokenServer.listen(0, "127.0.0.1", resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${noTokenServer.address().port}/api/bugs/1/status`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "Approved" })
        });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { message: "Human approval is not configured." });
    } finally {
        await new Promise((resolve, reject) => {
            noTokenServer.close((error) => error ? reject(error) : resolve());
        });
        noTokenApp.locals.closeDatabase();
    }
});

test("POST /api/bugs stores multiple reports with increasing IDs", async () => {
    const createdBugs = [];

    for (const title of ["Second report", "Third report"]) {
        const { response, bug } = await createBug(title);
        assert.equal(response.status, 201);
        createdBugs.push(bug);
    }

    assert.deepEqual(createdBugs.map((bug) => bug.id), [5, 6]);

    const response = await fetch(`${baseUrl}/api/bugs`);
    const bugs = await response.json();
    assert.equal(bugs.length, 6);
    assert.deepEqual(bugs.map((bug) => bug.title), [
        "Broken login",
        "Outbox persistence",
        "Acknowledgement report",
        "Rejectable report",
        "Second report",
        "Third report"
    ]);
});

test("bug reports survive an application restart", async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    app.locals.closeDatabase();

    app = createApp({ databasePath, outboxToken: "test-outbox-token" });
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const response = await fetch(`${baseUrl}/api/bugs`);
    const bugs = await response.json();

    assert.equal(response.status, 200);
    assert.equal(bugs.length, 6);
    assert.deepEqual(bugs.map((bug) => bug.id), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(bugs.map((bug) => bug.status), [
        "Approved",
        "Reported",
        "Reported",
        "Rejected",
        "Reported",
        "Reported"
    ]);
    assert.equal(bugs[0].severity, "Low");

    const pendingResponse = await fetch(`${baseUrl}/api/outbox/pending`, {
        headers: { Authorization: "Bearer test-outbox-token" }
    });
    const pendingEvents = await pendingResponse.json();
    assert.equal(pendingEvents.length, 5);
    assert.ok(pendingEvents.every((event) => event.eventType === "bug.created"));

    const linkedRows = app.locals.database.prepare(`
        SELECT outbox.bugId, bugs.id AS existingBugId, outbox.payload
        FROM outbox LEFT JOIN bugs ON bugs.id = outbox.bugId
        ORDER BY outbox.id
    `).all();
    assert.equal(linkedRows.length, 6);
    assert.ok(linkedRows.every((row) => row.existingBugId === row.bugId));
    assert.ok(linkedRows.every((row) => JSON.parse(row.payload).id === row.bugId));
    assert.deepEqual(app.locals.database.prepare("PRAGMA foreign_key_check").all(), []);
});
