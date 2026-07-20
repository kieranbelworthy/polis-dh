#!/usr/bin/env python3
"""Launch PostgreSQL themes and optional legacy DynamoDB Delphi workers."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import subprocess
import sys
import time

logging.basicConfig(
    level=os.environ.get("DELPHI_LOG_LEVEL", os.environ.get("LOG_LEVEL", "INFO")),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("delphi_worker_launcher")
processes: list[subprocess.Popen] = []
stopping = False


def is_true(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def automatic_themes_enabled() -> bool:
    configured = os.environ.get("DELPHI_AUTO_REFRESH_ENABLED", "true")
    return str(configured).strip().lower() not in {"0", "false", "no", "off"}


def configure_runtime_resources() -> None:
    """Bound native-library thread pools before either child process starts."""
    try:
        thread_count = max(1, int(os.environ.get("DELPHI_NUM_THREADS", "1")))
    except ValueError:
        thread_count = 1
        logger.warning("Invalid DELPHI_NUM_THREADS; using 1")
    os.environ["DELPHI_NUM_THREADS"] = str(thread_count)
    defaults = {
        "OMP_NUM_THREADS": str(thread_count),
        "OPENBLAS_NUM_THREADS": str(thread_count),
        "MKL_NUM_THREADS": str(thread_count),
        "NUMEXPR_NUM_THREADS": str(thread_count),
        "TOKENIZERS_PARALLELISM": "false",
    }
    for name, value in defaults.items():
        os.environ[name] = value


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Delphi background workers")
    parser.add_argument(
        "--postgres-only",
        action="store_true",
        help="Run automatic PostgreSQL themes without the legacy DynamoDB worker",
    )
    return parser.parse_args(argv)


def legacy_dynamodb_enabled(postgres_only: bool = False) -> bool:
    """Preserve the historical Docker default unless explicitly disabled."""
    if postgres_only:
        return False

    configured = os.environ.get("DELPHI_DYNAMODB_ENABLED", "").strip()
    if not configured:
        return True
    if is_true(configured):
        return True
    if configured.lower() in {"0", "false", "no", "off"}:
        return False
    logger.warning(
        "Invalid DELPHI_DYNAMODB_ENABLED=%r; preserving the enabled default",
        configured,
    )
    return True


def run_setup(command: list[str], label: str) -> None:
    logger.info("Running %s", label)
    result = subprocess.run(command, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"{label} failed with exit code {result.returncode}")


def prepare_legacy_worker() -> None:
    region = os.environ.get("AWS_REGION", "us-east-1")
    run_setup(
        [sys.executable, "create_dynamodb_tables.py", "--region", region],
        "DynamoDB table setup",
    )
    if os.environ.get("DYNAMODB_ENDPOINT"):
        run_setup([sys.executable, "setup_minio.py"], "local MinIO setup")
        run_setup(["./scripts/setup_ollama.sh"], "local Ollama model setup")


def legacy_worker_command() -> list[str]:
    region = os.environ.get("AWS_REGION", "us-east-1")
    command = [
        sys.executable,
        "scripts/job_poller.py",
        f"--interval={os.environ.get('POLL_INTERVAL', '2')}",
        f"--region={region}",
    ]
    if not os.environ.get("DYNAMODB_ENDPOINT") and region == "us-east-1":
        return ["ddtrace-run", *command]
    return command


def stop_all() -> None:
    for process in processes:
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 10
    for process in processes:
        remaining = max(0, deadline - time.monotonic())
        try:
            process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            process.kill()


def request_stop(_signum=None, _frame=None) -> None:
    global stopping
    stopping = True
    logger.info("Stopping Delphi workers")
    stop_all()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    configure_runtime_resources()
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    themes_enabled = automatic_themes_enabled()
    legacy_enabled = legacy_dynamodb_enabled(args.postgres_only)
    postgres_command = [sys.executable, "scripts/postgres_theme_worker.py"]
    postgres_process = None
    postgres_retry_at = 0.0
    if not themes_enabled:
        logger.info("PostgreSQL automatic themes are disabled by configuration")

    legacy_command = legacy_worker_command()
    legacy_process = None
    legacy_retry_at = 0.0
    if not legacy_enabled:
        logger.info("Legacy DynamoDB jobs are disabled for this process")
    if not themes_enabled and not legacy_enabled:
        logger.info("All Delphi workers are disabled; the supervisor will remain idle")

    try:
        while not stopping:
            if (
                themes_enabled
                and postgres_process is None
                and time.monotonic() >= postgres_retry_at
            ):
                try:
                    logger.info("Starting PostgreSQL automatic theme worker")
                    postgres_process = subprocess.Popen(postgres_command)
                    processes.append(postgres_process)
                except Exception:
                    postgres_retry_at = time.monotonic() + 30
                    logger.exception(
                        "Could not start PostgreSQL theme worker; "
                        "retrying in 30 seconds"
                    )

            if (
                legacy_enabled
                and legacy_process is None
                and time.monotonic() >= legacy_retry_at
            ):
                try:
                    prepare_legacy_worker()
                    logger.info("Starting optional legacy DynamoDB Delphi worker")
                    legacy_process = subprocess.Popen(legacy_command)
                    processes.append(legacy_process)
                except Exception:
                    legacy_retry_at = time.monotonic() + 30
                    logger.exception(
                        "Legacy DynamoDB setup failed; retrying in 30 seconds"
                    )

            for process in list(processes):
                return_code = process.poll()
                if return_code is not None:
                    if postgres_process is not None and process is postgres_process:
                        logger.error(
                            "PostgreSQL theme worker %s exited with %s; "
                            "retrying in 30 seconds",
                            process.pid,
                            return_code,
                        )
                        processes.remove(process)
                        postgres_process = None
                        postgres_retry_at = time.monotonic() + 30
                    else:
                        logger.error(
                            "Legacy Delphi worker %s exited with %s; "
                            "retrying in 30 seconds",
                            process.pid,
                            return_code,
                        )
                        processes.remove(process)
                        legacy_process = None
                        legacy_retry_at = time.monotonic() + 30
            time.sleep(1)
    finally:
        stop_all()


if __name__ == "__main__":
    main()
