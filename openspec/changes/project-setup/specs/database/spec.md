## ADDED Requirements

### Requirement: Self-hosted PostgreSQL
The system SHALL use a self-hosted PostgreSQL database. A shared database access module SHALL provide a configured connection pool to the backend and worker services.

#### Scenario: Connection pool initializes
- **WHEN** a service initializes the database module with a valid connection URL
- **THEN** the module establishes a connection pool and a basic connectivity query succeeds

#### Scenario: Invalid connection fails fast
- **WHEN** a service initializes the database module with an unreachable database
- **THEN** initialization fails with a clear error rather than hanging indefinitely

### Requirement: Versioned migrations
The system SHALL manage the database schema with versioned, forward-only migrations applied by a migration tool, invokable from the command line and from CI.

#### Scenario: Migrations apply to an empty database
- **WHEN** the migration command is run against an empty database
- **THEN** all migrations apply successfully and a migrations bookkeeping table records the applied versions

#### Scenario: Migrations are idempotent on re-run
- **WHEN** the migration command is run again against an already-migrated database
- **THEN** no migrations are re-applied and the command exits successfully

### Requirement: Baseline migration
The system SHALL include an initial baseline migration that establishes the migration tooling and bookkeeping, containing no Mailpigeon domain tables.

#### Scenario: Baseline applies cleanly
- **WHEN** the baseline migration is applied to a fresh database
- **THEN** it completes without error and leaves the migration bookkeeping in place
