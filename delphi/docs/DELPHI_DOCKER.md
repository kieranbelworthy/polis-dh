# Delphi Docker Container Guide

This document provides information about the Delphi Docker container setup and operation.

## Container Initialization

When the Delphi container starts, it performs the following steps:

1. Starts the PostgreSQL automatic-theme worker.
2. Initializes the legacy DynamoDB tables and starts the legacy job poller,
   preserving the container's behavior from before automatic themes were added.
3. When `DYNAMODB_ENDPOINT` is set, also prepares the local MinIO bucket and
   Ollama model. Remote AWS deployments retain their existing `ddtrace`
   startup path in `us-east-1`.

The platform-specific `--postgres-only` command-line flag suppresses the
legacy worker. Heroku selects this mode in `heroku.yml`; it is not the default
Docker image behavior.

## Environment Variables

The following environment variables control the container's behavior:

- `DYNAMODB_ENDPOINT`: Optional URL selecting local legacy DynamoDB setup
- `DELPHI_DYNAMODB_ENABLED`: Optional explicit override. Legacy DynamoDB is
  enabled by default for backward compatibility; set this to `false` for a
  PostgreSQL-themes-only standard Docker deployment.
- `DELPHI_AUTO_REFRESH_ENABLED`: Enables PostgreSQL automatic themes (default: true)
- `POLL_INTERVAL`: Polling interval in seconds for the job poller (default: 2)
- `LOG_LEVEL`: Logging level (default: INFO)
- `DATABASE_URL`: PostgreSQL database URL for math pipeline
- `DELPHI_DEV_OR_PROD`: Environment setting (dev/prod)

## Container Services

The Delphi container runs the following services:

1. **Automatic Theme Worker**: Polls PostgreSQL and atomically publishes versioned themes and assignments.
2. **Legacy Job Poller**: Runs by default for backward compatibility, or can be
   disabled explicitly without affecting automatic themes.
3. **Theme Pipeline**: Embeds and clusters eligible conversation statements without requiring Ollama.

## Troubleshooting

If the container exits, check that:

1. `DATABASE_URL` is correct and the theme migration has run.
2. The dyno or container has enough memory for sentence-transformers, UMAP, and EVōC.
3. If legacy jobs are enabled, the DynamoDB endpoint or AWS credentials are correct.

## Maintaining State

Automatic theme results are stored in PostgreSQL. Legacy Delphi results remain
in DynamoDB when that optional worker is enabled.
