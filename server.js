const express = require("express");
const path = require("path");
const fs = require("node:fs");
const { timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const SEVERITIES = ["Critical", "High", "Medium", "Low"];
const STATUSES = [
    "Reported",
    "Triaged",
    "In Development",
    "QA Review",
    "Human Approval",
    "Approved",
    "Rejected"
];
const STATUS_TRANSITIONS = {
    Reported: ["Triaged"],
    Triaged: ["In Development"],
    "In Development": ["QA Review"],
    "QA Review": ["In Development", "Human Approval"],
    "Human Approval": ["Approved", "Rejected"],
    Approved: [],
    Rejected: []
};

function parseBugId(value) {
    if (!/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
}

function hasValidApprovalToken(authorization, expectedToken) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization || "");
    if (!match || !expectedToken) {
        return false;
    }

    const supplied = Buffer.from(match[1]);
    const expected = Buffer.from(expectedToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function createApp({
    databasePath = process.env.CAMPUSOPS_DB_PATH || path.join(__dirname, "campusops.sqlite"),
    approvalToken = process.env.CAMPUSOPS_APPROVAL_TOKEN || "",
    outboxToken = process.env.CAMPUSOPS_OUTBOX_TOKEN || ""
} = {}) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
        CREATE TABLE IF NOT EXISTS bugs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('Reported', 'Triaged', 'In Development', 'QA Review', 'Human Approval', 'Approved', 'Rejected')),
            severity TEXT NOT NULL CHECK (severity IN ('Critical', 'High', 'Medium', 'Low')),
            createdAt TEXT NOT NULL
        )
    `);
    database.prepare("UPDATE bugs SET severity = 'Medium' WHERE severity = 'Pending triage'").run();
    database.exec(`
        CREATE TABLE IF NOT EXISTS outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            eventType TEXT NOT NULL,
            bugId INTEGER NOT NULL REFERENCES bugs(id),
            payload TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            acknowledgedAt TEXT
        )
    `);

    const listBugs = database.prepare(`
        SELECT id, title, description, status, severity, createdAt
        FROM bugs
        ORDER BY id
    `);
    const insertBug = database.prepare(`
        INSERT INTO bugs (title, description, status, severity, createdAt)
        VALUES (?, ?, ?, ?, ?)
    `);
    const getBugById = database.prepare(`
        SELECT id, title, description, status, severity, createdAt
        FROM bugs
        WHERE id = ?
    `);
    const updateBugSeverity = database.prepare("UPDATE bugs SET severity = ? WHERE id = ?");
    const updateBugStatus = database.prepare("UPDATE bugs SET status = ? WHERE id = ?");
    const listPendingEvents = database.prepare(`
        SELECT id, eventType, bugId, payload, createdAt
        FROM outbox WHERE acknowledgedAt IS NULL ORDER BY id
    `);
    const getEventById = database.prepare("SELECT id, acknowledgedAt FROM outbox WHERE id = ?");
    const acknowledgeEvent = database.prepare("UPDATE outbox SET acknowledgedAt = ? WHERE id = ? AND acknowledgedAt IS NULL");
    const insertEvent = database.prepare(`
        INSERT INTO outbox (eventType, bugId, payload, createdAt)
        VALUES (?, ?, ?, ?)
    `);

    const app = express();
    app.use(express.json({ strict: false }));
    app.use(express.static(path.join(__dirname, "public")));

    app.get("/api/health", (req, res) => {
        res.json({
            status: "online",
            project: "CampusOps"
        });
    });

    app.get("/api/bugs", (req, res) => {
        res.json(listBugs.all());
    });

    app.get("/api/outbox/pending", (req, res) => {
        if (!outboxToken) {
            return res.status(503).json({ message: "Manual handoff access is not configured." });
        }
        if (!hasValidApprovalToken(req.get("authorization"), outboxToken)) {
            return res.status(403).json({ message: "Manual handoff authorization is required." });
        }
        res.json(listPendingEvents.all().map((event) => ({
            ...event,
            payload: JSON.parse(event.payload)
        })));
    });

    app.post("/api/outbox/:id/ack", (req, res) => {
        if (!outboxToken) {
            return res.status(503).json({ message: "Manual handoff access is not configured." });
        }
        if (!hasValidApprovalToken(req.get("authorization"), outboxToken)) {
            return res.status(403).json({ message: "Manual handoff authorization is required." });
        }
        const eventId = parseBugId(req.params.id);
        if (eventId === null) {
            return res.status(400).json({ message: "Event ID must be a positive integer." });
        }
        const event = getEventById.get(eventId);
        if (!event) {
            return res.status(404).json({ message: "Outbox event not found." });
        }
        if (event.acknowledgedAt !== null) {
            return res.status(409).json({ message: "Outbox event was already acknowledged." });
        }
        const acknowledgedAt = new Date().toISOString();
        const result = acknowledgeEvent.run(acknowledgedAt, eventId);
        if (Number(result.changes) !== 1) {
            return res.status(409).json({ message: "Outbox event was already acknowledged." });
        }
        res.json({ id: eventId, acknowledgedAt });
    });

    app.patch("/api/bugs/:id/severity", (req, res) => {
        const bugId = parseBugId(req.params.id);
        if (bugId === null) {
            return res.status(400).json({ message: "Bug ID must be a positive integer." });
        }
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
            return res.status(400).json({ message: `Severity must be one of: ${SEVERITIES.join(", ")}.` });
        }

        const severity = typeof req.body.severity === "string" ? req.body.severity.trim() : "";
        if (!SEVERITIES.includes(severity)) {
            return res.status(400).json({ message: `Severity must be one of: ${SEVERITIES.join(", ")}.` });
        }

        if (!getBugById.get(bugId)) {
            return res.status(404).json({ message: "Bug report not found." });
        }

        updateBugSeverity.run(severity, bugId);
        res.json(getBugById.get(bugId));
    });

    app.patch("/api/bugs/:id/status", (req, res) => {
        const bugId = parseBugId(req.params.id);
        if (bugId === null) {
            return res.status(400).json({ message: "Bug ID must be a positive integer." });
        }
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
            return res.status(400).json({ message: `Status must be one of: ${STATUSES.join(", ")}.` });
        }

        const status = typeof req.body.status === "string" ? req.body.status.trim() : "";
        if (!STATUSES.includes(status)) {
            return res.status(400).json({ message: `Status must be one of: ${STATUSES.join(", ")}.` });
        }

        const bug = getBugById.get(bugId);
        if (!bug) {
            return res.status(404).json({ message: "Bug report not found." });
        }
        if (status !== bug.status && !STATUS_TRANSITIONS[bug.status].includes(status)) {
            return res.status(409).json({
                message: `Invalid status transition from ${bug.status} to ${status}.`
            });
        }

        if (status === "Approved" || status === "Rejected") {
            if (!approvalToken) {
                return res.status(503).json({ message: "Human approval is not configured." });
            }
            if (!hasValidApprovalToken(req.get("authorization"), approvalToken)) {
                return res.status(403).json({ message: "Human approval is required." });
            }
        }

        if (status !== bug.status) {
            updateBugStatus.run(status, bugId);
        }
        res.json(getBugById.get(bugId));
    });

    app.post("/api/bugs", (req, res) => {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
            return res.status(400).json({
                message: "Title and description are required."
            });
        }

        const { title, description } = req.body;

        if (typeof title !== "string" || typeof description !== "string") {
            return res.status(400).json({
                message: "Title and description are required."
            });
        }

        const normalizedTitle = title.trim();
        const normalizedDescription = description.trim();

        if (!normalizedTitle || !normalizedDescription) {
            return res.status(400).json({
                message: "Title and description are required."
            });
        }

        const status = "Reported";
        const severity = "Medium";
        const createdAt = new Date().toISOString();
        let bug;
        database.exec("BEGIN IMMEDIATE");
        try {
            const result = insertBug.run(normalizedTitle, normalizedDescription, status, severity, createdAt);
            bug = {
                id: Number(result.lastInsertRowid),
                title: normalizedTitle,
                description: normalizedDescription,
                status,
                severity,
                createdAt
            };
            insertEvent.run("bug.created", bug.id, JSON.stringify(bug), createdAt);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            return res.status(500).json({ message: "Could not save bug report and handoff event." });
        }

        res.status(201).json(bug);
    });

    app.locals.closeDatabase = () => database.close();
    app.locals.database = database;
    return app;
}

if (require.main === module) {
    const app = createApp();
    app.listen(PORT, () => {
        console.log(`CampusOps running at http://localhost:${PORT}`);
    });
}

module.exports = createApp;
