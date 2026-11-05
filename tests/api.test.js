const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createServer } = require("node:http");
const app = require("../server");

let server;
let baseUrl;

before(async () => {
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
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
    assert.equal(bug.severity, "Pending triage");
    assert.ok(Number.isNaN(Date.parse(bug.createdAt)) === false);

    const listResponse = await fetch(`${baseUrl}/api/bugs`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [bug]);
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
