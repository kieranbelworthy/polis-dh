import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("external management API deployment isolation", () => {
  test("Heroku explicitly selects PostgreSQL-only operation", () => {
    const manifest = readRepoFile("heroku.yml");

    expect(manifest).toContain(
      "env DELPHI_DYNAMODB_ENABLED=false npm run serve"
    );
    expect(manifest).toContain(
      "python scripts/start_workers.py --postgres-only"
    );
  });

  test("the standard Delphi image retains its portable default command", () => {
    const dockerfile = readRepoFile("delphi/Dockerfile");

    expect(dockerfile).toContain('CMD ["python", "scripts/start_workers.py"]');
    expect(dockerfile).not.toContain(
      'CMD ["python", "scripts/start_workers.py", "--postgres-only"]'
    );
  });

  test("both fresh Docker database modes install the theme schema", () => {
    const freshDatabaseImage = readRepoFile("server/Dockerfile-db");
    const restoredDatabaseImage = readRepoFile("server/Dockerfile-pdb");
    const restoreScript = readRepoFile("server/init-db.sh");

    expect(freshDatabaseImage).toContain(
      "COPY ./postgres/migrations/*.sql /docker-entrypoint-initdb.d/"
    );
    expect(restoredDatabaseImage).toContain(
      "000020_create_delphi_theme_analysis.sql"
    );
    expect(restoreScript).toContain(
      "/opt/polis/migrations/000020_create_delphi_theme_analysis.sql"
    );
  });

  test("the standard root environment exposes external API configuration", () => {
    const exampleEnvironment = readRepoFile("example.env");
    const composeManifest = readRepoFile("docker-compose.yml");

    expect(exampleEnvironment).toMatch(/^EXTERNAL_API_KEY=$/m);
    expect(exampleEnvironment).toMatch(/^EXTERNAL_API_OWNER_USER_ID=$/m);
    expect(composeManifest).toContain("EXTERNAL_API_KEY=${EXTERNAL_API_KEY:-}");
    expect(composeManifest).toContain(
      "EXTERNAL_API_OWNER_USER_ID=${EXTERNAL_API_OWNER_USER_ID:-}"
    );
    expect(composeManifest).toContain("MATH_ENV=${MATH_ENV:-prod}");
  });

  test("automatic theme discovery is limited to external-API-managed jobs", () => {
    const migration = readRepoFile(
      "server/postgres/migrations/000020_create_delphi_theme_analysis.sql"
    );
    const worker = readRepoFile("delphi/scripts/postgres_theme_worker.py");

    expect(migration).toContain("UPDATE delphi_theme_jobs SET");
    expect(migration).not.toContain("ON CONFLICT (zid) DO UPDATE SET");
    expect(worker).not.toContain("existing_conversation");
    expect(worker).not.toContain("FROM comments c\n              WHERE");
  });

  test("only external routes enroll conversations in automatic themes", () => {
    const standardCommentRoutes = readRepoFile("server/src/routes/comments.ts");
    const externalRoutes = readRepoFile("server/src/routes/external.ts");

    expect(standardCommentRoutes).not.toContain(
      "scheduleAutomaticDelphiAnalysisForStatementWrite"
    );
    expect(externalRoutes).toContain(
      "scheduleAutomaticDelphiAnalysisForStatementWrite"
    );
  });
});
