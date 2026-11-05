const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const bugs = [];
let nextId = 1;

app.get("/api/health", (req, res) => {
    res.json({
        status: "online",
        project: "CampusOps"
    });
});

app.get("/api/bugs", (req, res) => {
    res.json(bugs);
});

app.post("/api/bugs", (req, res) => {
    const { title, description } = req.body;

    if (!title || !description) {
        return res.status(400).json({
            message: "Title and description are required."
        });
    }

    const bug = {
        id: nextId++,
        title: title.trim(),
        description: description.trim(),
        status: "Reported",
        severity: "Pending triage",
        createdAt: new Date().toISOString()
    };

    bugs.push(bug);
    res.status(201).json(bug);
});

app.listen(PORT, () => {
    console.log(`CampusOps running at http://localhost:${PORT}`);
});
