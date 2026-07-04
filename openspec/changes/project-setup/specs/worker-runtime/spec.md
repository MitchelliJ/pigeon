## ADDED Requirements

### Requirement: Worker runtime process
The system SHALL provide a long-running Node.js/TypeScript worker process (`apps/worker`) that starts from the same centralized configuration as the backend and shares the database access module. The worker SHALL NOT implement any Mailpigeon jobs in this change.

#### Scenario: Worker starts
- **WHEN** the worker process is started with valid configuration
- **THEN** it initializes, establishes a database connection, and logs that it is running

#### Scenario: Missing configuration aborts startup
- **WHEN** the worker is started with missing or invalid required configuration
- **THEN** it exits with a non-zero code and logs the validation error

### Requirement: Liveness signaling
The worker SHALL emit a periodic liveness/heartbeat signal so that local tooling and the deployment host can detect that it is alive.

#### Scenario: Heartbeat emitted
- **WHEN** the worker has been running
- **THEN** it emits a heartbeat at a configured interval (e.g. a log line or updated liveness marker)

### Requirement: Graceful shutdown
The worker SHALL shut down cleanly on a termination signal.

#### Scenario: Graceful shutdown on SIGTERM
- **WHEN** the running worker process receives SIGTERM
- **THEN** it stops its work loop, releases database resources, and exits with code 0
