## ADDED Requirements

### Requirement: Continuous integration pipeline
The system SHALL provide a CI pipeline that runs automatically on every push and pull request, installing dependencies and validating the monorepo.

#### Scenario: CI runs on pull request
- **WHEN** a pull request is opened or updated
- **THEN** the CI pipeline runs automatically and reports a pass/fail status

### Requirement: Lint, typecheck, and build
The CI pipeline SHALL lint, typecheck, and build the workspace, failing the run if any step fails.

#### Scenario: Failing typecheck fails CI
- **WHEN** the workspace contains a type error
- **THEN** the CI pipeline fails at the typecheck step and reports failure

#### Scenario: Clean workspace passes
- **WHEN** the workspace lints, typechecks, and builds without error
- **THEN** these CI steps pass

### Requirement: Migrations validated against ephemeral Postgres
The CI pipeline SHALL run database migrations against a throwaway PostgreSQL instance to verify they apply cleanly.

#### Scenario: Migrations applied in CI
- **WHEN** the CI pipeline reaches the migration step
- **THEN** it starts an ephemeral Postgres, applies all migrations successfully, and tears it down

### Requirement: Container image build verification
The CI pipeline SHALL build the server and worker container images to verify the Dockerfiles remain valid.

#### Scenario: Image build step
- **WHEN** the CI pipeline reaches the image build step
- **THEN** the server and worker images build successfully
