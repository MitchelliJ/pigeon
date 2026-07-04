## ADDED Requirements

### Requirement: Container images for services
The system SHALL provide Dockerfiles that build runnable container images for the backend service and the worker, using configuration supplied at runtime via environment variables.

#### Scenario: Images build
- **WHEN** the server and worker images are built from their Dockerfiles
- **THEN** each build completes successfully and produces a runnable image

#### Scenario: Container runs from environment config
- **WHEN** a built image is run with the required environment variables provided
- **THEN** the contained service starts and passes its health/liveness check

### Requirement: Local development stack
The system SHALL provide a `docker-compose` configuration that runs the full local stack — PostgreSQL, the backend service, and the worker — wired together with development configuration.

#### Scenario: Local stack starts
- **WHEN** a developer runs the compose stack from a clean checkout
- **THEN** Postgres, the backend, and the worker all start and the backend's readiness endpoint reports healthy

#### Scenario: Migrations run against the local stack
- **WHEN** the migration command is run against the compose Postgres
- **THEN** migrations apply successfully

### Requirement: Hetzner deployment
The system SHALL provide a documented, repeatable process to deploy the containerized services and database to a self-hosted Hetzner host, with secrets supplied via the host environment.

#### Scenario: Deploy to Hetzner host
- **WHEN** the documented deployment process is executed against a provisioned Hetzner host
- **THEN** the backend and worker run on the host, connected to PostgreSQL, and the backend's health endpoint is reachable

#### Scenario: Rollback to previous image
- **WHEN** a deployment needs to be reverted
- **THEN** the process supports redeploying the previous image version without data loss
