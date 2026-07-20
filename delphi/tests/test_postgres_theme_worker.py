import os
from unittest.mock import patch

import numpy as np

from scripts.postgres_theme_worker import (
    Policy,
    _fallback_layers,
    _theme_mode,
    configure_runtime_resources,
    keyword_labels,
)


def test_default_policy_needs_no_new_environment_variables():
    names = [
        "POLL_INTERVAL",
        "DELPHI_AUTO_REFRESH_DEBOUNCE_MS",
        "DELPHI_AUTO_REFRESH_MAX_DELAY_MS",
        "DELPHI_AUTO_REFRESH_MIN_INTERVAL_MS",
        "DELPHI_AUTO_REFRESH_MIN_STATEMENTS",
        "DELPHI_THEME_LEASE_SECONDS",
        "DELPHI_THEME_MAX_ATTEMPTS",
        "DELPHI_THEME_RUN_RETENTION",
    ]
    with patch.dict(os.environ, {name: "" for name in names}, clear=False):
        policy = Policy.from_env()

    assert policy.debounce_ms == 300_000
    assert policy.enabled is True
    assert policy.max_delay_ms == 3_600_000
    assert policy.min_interval_ms == 1_800_000
    assert policy.min_statements == 5
    assert policy.max_attempts == 3
    assert policy.run_retention == 10


def test_automatic_themes_can_be_disabled_without_affecting_other_workers():
    with patch.dict(
        os.environ,
        {"DELPHI_AUTO_REFRESH_ENABLED": "false"},
        clear=False,
    ):
        policy = Policy.from_env()

    assert policy.enabled is False


def test_standard_docker_theme_mode_preserves_embedding_default():
    with patch.dict(os.environ, {}, clear=True):
        assert _theme_mode(11) == "embedding"


def test_tfidf_mode_is_available_for_constrained_workers():
    with patch.dict(
        os.environ,
        {"DELPHI_THEME_EMBEDDING_MODE": "tfidf"},
        clear=False,
    ):
        assert _theme_mode(11) == "tfidf"


def test_auto_theme_mode_only_uses_embeddings_above_configured_threshold():
    with patch.dict(
        os.environ,
        {
            "DELPHI_THEME_EMBEDDING_MODE": "auto",
            "DELPHI_THEME_EMBEDDING_MAX_STATEMENTS": "10",
        },
        clear=False,
    ):
        assert _theme_mode(10) == "tfidf"
        assert _theme_mode(11) == "embedding"


def test_runtime_resource_defaults_bound_native_thread_pools():
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


def test_keyword_labels_are_local_and_dashboard_friendly():
    labels = keyword_labels(
        [
            "Night buses need more frequent service",
            "Night bus frequency should improve",
            "Publish monthly reliability reports",
            "Bus reliability data should be public",
        ],
        [np.asarray([0, 0, 1, 1])],
    )

    assert labels[(0, 0)]
    assert labels[(0, 1)]
    assert "Example:" not in labels[(0, 0)]
    assert len(labels[(0, 0)]) < 100


def test_fallback_clustering_never_requests_more_clusters_than_statements():
    vectors = np.asarray(
        [
            [1.0, 0.0],
            [0.9, 0.1],
            [0.0, 1.0],
            [0.1, 0.9],
            [0.5, 0.5],
        ]
    )
    layers = _fallback_layers(vectors)

    assert layers
    assert all(len(layer) == len(vectors) for layer in layers)
    assert all(len(np.unique(layer)) <= len(vectors) for layer in layers)
