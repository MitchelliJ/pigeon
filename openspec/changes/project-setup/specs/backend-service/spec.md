## ADDED Requirements

### Requirement: Backend HTTP service skeleton
The system SHALL provide a Node.js/TypeScript HTTP backend service (`apps/server`) that starts from centralized configuration and serves HTTP requests. The service SHALL NOT implement any Mailpigeon business logic in this change.

#### Scenario: Service starts and listens
- **WHEN** the server process is started with valid configuration
- **THEN** it binds to the configured host and port and logs that it is listening

#### Scenario: Missing configuration aborts startup
- **WHEN** the server process is started with missing or invalid required configuration
- **THEN** it exits with a non-zero code before binding to the port and logs the validation error

### Requirement: Health and readiness endpoints
The backend service SHALL expose a liveness endpoint and a readiness endpoint for use by local tooling, CI, and the deployment host.

#### Scenario: Liveness check
- **WHEN** a GET request is made to the health endpoint
- **THEN** the service responds with HTTP 200 and a JSON body indicating the service is up

#### Scenario: Readiness reflects database connectivity
- **WHEN** a GET request is made to the readiness endpoint and the database is reachable
- **THEN** the service responds with HTTP 200
- **AND WHEN** the database is unreachable
- **THEN** the service responds with HTTP 503

### Requirement: Graceful startup and shutdown
The backend service SHALL shut down cleanly when it receives a termination signal.

#### Scenario: Graceful shutdown on SIGTERM
- **WHEN** the running server process receives SIGTERM
- **THEN** it stops accepting new connections, releases database resources, and exits with code 0
