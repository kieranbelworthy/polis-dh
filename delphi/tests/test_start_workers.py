import os
import sys
from unittest.mock import call, patch

from scripts import start_workers
from scripts.start_workers import (
    automatic_themes_enabled,
    configure_runtime_resources,
    legacy_dynamodb_enabled,
    legacy_worker_command,
    parse_args,
    prepare_legacy_worker,
)


class FakeProcess:
    def __init__(self, pid, return_code=None):
        self.pid = pid
        self.return_code = return_code
        self.terminated = False

    def poll(self):
        return self.return_code

    def terminate(self):
        self.terminated = True
        self.return_code = 0

    def wait(self, timeout=None):
        return self.return_code

    def kill(self):
        self.return_code = -9


def test_standard_aws_deployment_preserves_legacy_worker_and_ddtrace():
    with patch.dict(
        os.environ,
        {
            "DYNAMODB_ENDPOINT": "",
            "DELPHI_DYNAMODB_ENABLED": "",
            "AWS_REGION": "us-east-1",
            "POLL_INTERVAL": "7",
        },
        clear=False,
    ):
        assert legacy_dynamodb_enabled() is True
        assert legacy_worker_command() == [
            "ddtrace-run",
            sys.executable,
            "scripts/job_poller.py",
            "--interval=7",
            "--region=us-east-1",
        ]


def test_launcher_bounds_native_thread_pools_before_children_start():
    names = [
        "DELPHI_NUM_THREADS",
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "TOKENIZERS_PARALLELISM",
    ]
    with patch.dict(os.environ, {name: "" for name in names}, clear=False):
        configure_runtime_resources()
        assert os.environ["DELPHI_NUM_THREADS"] == "1"
        assert all(os.environ[name] == "1" for name in names[1:5])
        assert os.environ["TOKENIZERS_PARALLELISM"] == "false"


def test_standard_local_compose_preserves_legacy_setup():
    with patch.dict(
        os.environ,
        {
            "DYNAMODB_ENDPOINT": "http://dynamodb:8000",
            "DELPHI_DYNAMODB_ENABLED": "",
            "AWS_REGION": "us-west-2",
        },
        clear=False,
    ), patch("scripts.start_workers.run_setup") as run_setup:
        assert legacy_dynamodb_enabled() is True
        assert legacy_worker_command()[0] == sys.executable
        prepare_legacy_worker()

    assert run_setup.call_args_list == [
        call(
            [sys.executable, "create_dynamodb_tables.py", "--region", "us-west-2"],
            "DynamoDB table setup",
        ),
        call([sys.executable, "setup_minio.py"], "local MinIO setup"),
        call(["./scripts/setup_ollama.sh"], "local Ollama model setup"),
    ]


def test_heroku_postgres_only_mode_disables_legacy_worker():
    with patch.dict(
        os.environ,
        {"DYNAMODB_ENDPOINT": "http://dynamodb:8000"},
        clear=False,
    ):
        args = parse_args(["--postgres-only"])
        assert legacy_dynamodb_enabled(args.postgres_only) is False


def test_explicit_configuration_can_disable_legacy_worker():
    with patch.dict(
        os.environ,
        {"DYNAMODB_ENDPOINT": "", "DELPHI_DYNAMODB_ENABLED": "false"},
        clear=False,
    ):
        assert legacy_dynamodb_enabled() is False


def test_invalid_legacy_override_does_not_silently_disable_existing_jobs():
    with patch.dict(
        os.environ,
        {"DELPHI_DYNAMODB_ENABLED": "typo"},
        clear=False,
    ):
        assert legacy_dynamodb_enabled() is True


def test_automatic_themes_can_be_disabled_without_disabling_legacy_jobs():
    with patch.dict(
        os.environ,
        {
            "DELPHI_AUTO_REFRESH_ENABLED": "false",
            "DELPHI_DYNAMODB_ENABLED": "",
        },
        clear=False,
    ):
        assert automatic_themes_enabled() is False
        assert legacy_dynamodb_enabled() is True


def test_postgres_worker_failure_does_not_remove_legacy_worker():
    postgres = FakeProcess(101, return_code=1)
    legacy = FakeProcess(102)

    def stop_after_first_cycle(_seconds):
        start_workers.stopping = True

    with patch.dict(
        os.environ,
        {
            "DELPHI_AUTO_REFRESH_ENABLED": "true",
            "DELPHI_DYNAMODB_ENABLED": "true",
        },
        clear=False,
    ), patch.object(start_workers, "processes", []), patch.object(
        start_workers, "stopping", False
    ), patch.object(start_workers.signal, "signal"), patch.object(
        start_workers, "prepare_legacy_worker"
    ), patch.object(
        start_workers.subprocess, "Popen", side_effect=[postgres, legacy]
    ), patch.object(
        start_workers.time, "monotonic", return_value=0
    ), patch.object(
        start_workers.time, "sleep", side_effect=stop_after_first_cycle
    ):
        start_workers.main([])
        assert postgres not in start_workers.processes
        assert legacy in start_workers.processes


def test_legacy_worker_failure_does_not_remove_postgres_worker():
    postgres = FakeProcess(201)
    legacy = FakeProcess(202, return_code=1)

    def stop_after_first_cycle(_seconds):
        start_workers.stopping = True

    with patch.dict(
        os.environ,
        {
            "DELPHI_AUTO_REFRESH_ENABLED": "true",
            "DELPHI_DYNAMODB_ENABLED": "true",
        },
        clear=False,
    ), patch.object(start_workers, "processes", []), patch.object(
        start_workers, "stopping", False
    ), patch.object(start_workers.signal, "signal"), patch.object(
        start_workers, "prepare_legacy_worker"
    ), patch.object(
        start_workers.subprocess, "Popen", side_effect=[postgres, legacy]
    ), patch.object(
        start_workers.time, "monotonic", return_value=0
    ), patch.object(
        start_workers.time, "sleep", side_effect=stop_after_first_cycle
    ):
        start_workers.main([])
        assert postgres in start_workers.processes
        assert legacy not in start_workers.processes
