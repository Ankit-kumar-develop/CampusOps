# CampusOps

AI-assisted software development workflow with a **manual agent handoff**. Switch is not connected automatically.

## Overview

CampusOps supports a human-operated workflow with three specialized agent roles:

- **Triager:** Classifies bugs, identifies possible root causes, and creates development tasks.
- **Developer:** Investigates bugs and proposes fixes on isolated Git branches.
- **QA Reviewer:** Independently reviews proposed fixes and tests for regressions.

The human project owner retains final approval. No automatic merging or deployment is performed.

## Current Features

- Bug reporting dashboard
- Express.js backend
- Bug report creation and listing API
- SQLite-backed bug severity and status lifecycle
- SQLite outbox for durable bug-created handoff events
- Manual Triager brief copying from the dashboard

## Bug Lifecycle API

Bug severity is one of `Critical`, `High`, `Medium`, or `Low`. New reports default to `Medium`.

- `PATCH /api/bugs/:id/severity` with `{ "severity": "High" }` updates severity.
- `PATCH /api/bugs/:id/status` with `{ "status": "Triaged" }` updates status.
- Status flow: `Reported` → `Triaged` → `In Development` → `QA Review` → `Human Approval` → `Approved` or `Rejected`. QA may return work from `QA Review` to `In Development`.

The API requires an `Authorization: Bearer <token>` header to set `Approved` or `Rejected`. Configure `CAMPUSOPS_APPROVAL_TOKEN` in the server environment and provide the token only to the human approver. If no token is configured, terminal decisions are disabled and return `503`; a missing or incorrect token returns `403`.

## Tech Stack

- Node.js
- Express.js
- HTML, CSS, JavaScript
- Git and GitHub
- Optional external agent workflow, started manually by the operator

## Run Locally

1. Install Node.js.
2. Clone this repository.
3. Run `npm install`.
4. For authenticated outbox API consumers, set `CAMPUSOPS_OUTBOX_TOKEN` to a private bearer token. In PowerShell: `$env:CAMPUSOPS_OUTBOX_TOKEN = "your-local-secret"`.
5. Optionally set `CAMPUSOPS_APPROVAL_TOKEN` to a different private token for human approval.
6. Run `npm start`.
7. Open http://localhost:3000.

## Manual Handoff Demo

1. Submit a bug in the dashboard. The bug and its `bug.created` notification are saved together in SQLite.
2. In the `Reported` column, choose **Copy Triager brief (manual)**, then paste the brief into the agent workflow you operate. The brief includes the bug ID, title, description, and report time.
3. Outbox consumers can retrieve pending events with `GET /api/outbox/pending` and `Authorization: Bearer <CAMPUSOPS_OUTBOX_TOKEN>`.
4. After manually handling an event, acknowledge it with `POST /api/outbox/<event-id>/ack` using the same bearer header. An event can be acknowledged once; duplicate acknowledgements return `409`.

If `CAMPUSOPS_OUTBOX_TOKEN` is unset, the outbox endpoints return `503`. The dashboard copy flow does not require an outbox token. No Switch API or automatic delivery is configured. Run the automated suite with `npm test`.

## Safety

AI agents may analyze and propose code changes, but the human project owner retains final approval. Agents must not merge or deploy changes automatically.
