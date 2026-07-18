import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "run_delphi.py"
SPEC = importlib.util.spec_from_file_location("run_delphi_wrapper", MODULE_PATH)
run_delphi = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(run_delphi)


class RunDelphiWrapperTest(unittest.TestCase):
    def test_parses_explicit_false_as_false(self):
        self.assertFalse(run_delphi.parse_bool_argument("false"))
        self.assertTrue(run_delphi.parse_bool_argument("TRUE"))

    def test_missing_model_fails_before_reset(self):
        with patch.dict(os.environ, {"OLLAMA_MODEL": ""}, clear=False), patch.object(
            sys, "argv", ["run_delphi.py", "--zid=42"]
        ), patch.object(run_delphi.subprocess, "run") as subprocess_run:
            with self.assertRaises(SystemExit) as raised:
                run_delphi.main()

        self.assertEqual(raised.exception.code, 1)
        subprocess_run.assert_not_called()

    def test_narrative_failure_is_returned_to_the_job_worker(self):
        with patch.dict(
            os.environ, {"OLLAMA_MODEL": "test-model"}, clear=False
        ), patch.object(
            sys,
            "argv",
            [
                "run_delphi.py",
                "--zid=42",
                "--skip-visualizations",
                "--include_moderation=true",
            ],
        ), patch.object(
            run_delphi.subprocess,
            "run",
            side_effect=[
                SimpleNamespace(returncode=0),
                SimpleNamespace(returncode=0),
                SimpleNamespace(returncode=7),
            ],
        ) as subprocess_run:
            with self.assertRaises(SystemExit) as raised:
                run_delphi.main()

        self.assertEqual(raised.exception.code, 7)
        self.assertEqual(subprocess_run.call_count, 3)


if __name__ == "__main__":
    unittest.main()
