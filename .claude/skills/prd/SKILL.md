---
name: prd
description: Generate a Product Requirements Document (PRD) for a feature. Invoke when a new feature is to be implemented or when significant existing logic is being changed.
model: claude-opus-4-8
---

Act as an experienced product manager and software engineer.

The feature to build: $ARGUMENTS

## Process

1. **Fetch project context:** Read `vibes/spec-*.md` (the project spec) and `vibes/coding-guidelines.md`.
2. **Receive feature description:** Use `$ARGUMENTS` as the initial feature description. If empty, ask the user to describe the feature.
3. **Ask Clarifying Questions:** Interview the user relentlessly about the feature until a shared understanding is reached and user stories can be written with confidence. Resolve each decision required for the structure below. Ask questions one at the time, suggest suitable options with pros and cons and let the user decide. Label questions 1., 2., 3., et cetera. Label suitable options A., B., C., et cetera. If a question can be answered by exploring the spec, coding-guidelines or codebase, do that instead.
4. **Ask:** Ask the user the open ended questions. Label these OQ1, OQ2, et cetera.
5. **Save:** Based on the user answers and the structure below, create PRD and save to `vibes/[N]. [Feature Name]/prd-[feature-name].md`. Determine `[N]` by scanning existing `vibes/[0-9]*` feature folders and taking the next integer (numbers are unpadded and Title Case, e.g. `72. Conversational Context Propagation`). E.g. `vibes/73. Authentication/prd-authentication.md`. The PRD should be clear, concise, and written in a way a junior developer can understand and implement this feature.
6. **Confirm:** Wait for user to approve PRD and optionally answer open questions.
7. When done, optionally update PRD and invoke the create-tasks skill.

## PRD Structure

1. **Introduction/Overview** — Brief summary of the feature and the problem it solves.
2. **User Stories** — (As a [user], I want to [action] so that [benefit])
3. **Functional Requirements**
4. **Technical Requirements**
5. **Acceptance criteria**
6. **Open Questions** — Remaining unknowns needing clarification
7. **Non-Goals (Out of Scope)** — Explicit exclusions to manage scope
