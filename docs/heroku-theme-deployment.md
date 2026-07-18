# Heroku Theme Analysis Deployment

The external management theme endpoint runs on Heroku with the existing Pol.is
PostgreSQL database and one additional `delphi` process. It does not require
DynamoDB, AWS credentials, MinIO, S3, Ollama, or a separate model service.

## Deploy

The app must already use the container stack declared in `heroku.yml` and have
`DATABASE_URL` configured. Keep the existing external API configuration:

```text
EXTERNAL_API_KEY
EXTERNAL_API_OWNER_USER_ID
MATH_ENV
```

No new required configuration variables are introduced for themes. Deploy the
current branch normally:

```bash
git push heroku HEAD:main
```

Heroku builds the `web`, `worker`, and `delphi` images. The release phase reuses
the web image to apply only the idempotent theme migration under a PostgreSQL
advisory lock. A migration failure prevents the new release from becoming
active. Heroku's process commands disable legacy DynamoDB reads in the web
process and start the shared Delphi image with `--postgres-only`. This prevents
DynamoDB, MinIO, and Ollama startup on Heroku without adding a config variable
or changing the image's standard Docker defaults.

After the first successful deployment, scale one Delphi process:

```bash
heroku ps:scale web=1 worker=1 delphi=1 -a YOUR_APP
heroku ps -a YOUR_APP
heroku logs --tail --dyno delphi -a YOUR_APP
```

Delphi loads Torch, sentence-transformers, UMAP, and EVōC. Benchmark a
representative small, medium, and large conversation before choosing its dyno
size. Select the smallest tier whose memory limit is at least 30 percent above
the measured peak and verify that no R14 memory errors occur.

## Expected lifecycle

After at least five eligible statements exist in an external-API-managed
conversation, the API registers its managed job and the database trigger keeps
that job dirty after later changes. Ordinary Pol.is conversations are not
automatically scanned. The worker waits for the debounce window, claims the
job, and publishes themes and assignments together. Repeated API calls or
worker polls do not create another run. A new statement or moderation change
advances the source revision; votes update the API's live response statistics
without a new semantic run.

To pause analysis without affecting the API or math worker:

```bash
heroku ps:scale delphi=0 -a YOUR_APP
```

Completed theme data remains available while the worker is stopped.

## Why Ollama is optional

The bundled default produces clusters with sentence-transformer embeddings and
names them from their strongest TF-IDF keywords. These names are deterministic,
local, inexpensive, and sufficient for dashboard filtering and exploration.

Ollama can improve presentation by turning representative statements and
keywords into a concise contextual phrase—for example, converting
`night · buses · frequency · service` into `Late-Night Bus Frequency`. It does
not improve audience response statistics and is not required to discover the
clusters.

A future enhancement can add an asynchronous naming pass which reads an
already-published run, calls a configured Ollama host, and updates only its
display labels. It should remain opt-in, retain keyword labels when unavailable,
and never block clustering or publication. A normal Heroku deployment should
use the bundled keyword naming path.

## Standard Docker deployments

Docker Compose continues to start the existing DynamoDB and Ollama services for
legacy Delphi narrative/report features. The same Delphi container also polls
the PostgreSQL automatic-theme queue. The standard image keeps its historical
legacy DynamoDB worker enabled by default, including remote AWS deployments
without `DYNAMODB_ENDPOINT`. To intentionally run only automatic themes outside
Heroku, set `DELPHI_DYNAMODB_ENABLED=false`.

New PostgreSQL containers apply migration `000020` during initialization. For
an existing database volume, apply that migration once before restarting the
server and Delphi containers:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f server/postgres/migrations/000020_create_delphi_theme_analysis.sql
```
