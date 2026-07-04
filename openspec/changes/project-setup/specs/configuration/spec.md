## ADDED Requirements

### Requirement: Centralized typed configuration
The system SHALL provide a single shared configuration module that loads settings from environment variables, parses and validates them against a typed schema, and exposes a strongly-typed config object consumed by the backend and worker.

#### Scenario: Valid environment produces typed config
- **WHEN** the configuration module is loaded with all required environment variables present and valid
- **THEN** it returns a typed configuration object with parsed values

#### Scenario: Invalid environment fails fast
- **WHEN** a required variable is missing or a value fails validation (e.g. a malformed URL or non-numeric port)
- **THEN** the module throws with a message identifying the offending variable(s) and the process does not continue startup

### Requirement: Secret loading
The configuration module SHALL load secrets (such as the database password/connection URL) from the environment and SHALL NOT log secret values.

#### Scenario: Secrets are not logged
- **WHEN** configuration is loaded and any diagnostic/config summary is logged
- **THEN** secret values are omitted or redacted from the output

### Requirement: Environment templating
The repository SHALL provide an example environment file documenting every configuration variable, with no real secret values committed.

#### Scenario: Example env lists all variables
- **WHEN** a developer inspects the example environment file
- **THEN** it lists every variable the configuration schema requires, with placeholder values only
