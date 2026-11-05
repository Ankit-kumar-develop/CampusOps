# CampusOps

AI-assisted software development workflow powered by collaborative Switch agents.

## Overview

CampusOps coordinates bug reports through three specialized AI agents:

- **Triager:** Classifies bugs, identifies possible root causes, and creates development tasks.
- **Developer:** Investigates bugs and proposes fixes on isolated Git branches.
- **QA Reviewer:** Independently reviews proposed fixes and tests for regressions.

The human project owner retains final approval. No automatic merging or deployment is performed.

## Current Features

- Bug reporting dashboard
- Express.js backend
- Bug report creation and listing API
- SQLite-backed bug severity and status lifecycle
- Switch-based agent collaboration (configured separately)

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
- Switch Console and Codex agents

## Run Locally

1. Install Node.js.
2. Clone this repository.
3. Run `npm install`.
4. Run `npm start`.
5. Open http://localhost:3000.

## Safety

AI agents may analyze and propose code changes, but the human project owner retains final approval. Agents must not merge or deploy changes automatically.
