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
- Bug status tracking
- Switch-based agent collaboration (configured separately)

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
