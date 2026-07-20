#!/usr/bin/env python3
"""Self-managing PostgreSQL worker for dashboard theme analysis."""

from __future__ import annotations

import logging
import math
import os
import resource
import signal
import socket
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values

logging.basicConfig(
    level=os.environ.get("DELPHI_LOG_LEVEL", os.environ.get("LOG_LEVEL", "INFO")),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("postgres_theme_worker")

running = True
_embedding_model: Any = None
_embedding_model_path: str | None = None


def configure_runtime_resources() -> None:
    """Keep native numerical libraries from multiplying worker memory."""
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


def _non_negative_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, str(default))))
    except ValueError:
        logger.warning("Invalid %s; using %s", name, default)
        return default


@dataclass(frozen=True)
class Policy:
    enabled: bool
    poll_interval_seconds: int
    debounce_ms: int
    max_delay_ms: int
    min_interval_ms: int
    min_statements: int
    lease_seconds: int
    max_attempts: int
    run_retention: int

    @classmethod
    def from_env(cls) -> "Policy":
        enabled_value = os.environ.get("DELPHI_AUTO_REFRESH_ENABLED", "true")
        return cls(
            enabled=str(enabled_value).strip().lower() not in {"0", "false", "no", "off"},
            poll_interval_seconds=_non_negative_int("POLL_INTERVAL", 2),
            debounce_ms=_non_negative_int("DELPHI_AUTO_REFRESH_DEBOUNCE_MS", 300_000),
            max_delay_ms=_non_negative_int("DELPHI_AUTO_REFRESH_MAX_DELAY_MS", 3_600_000),
            min_interval_ms=_non_negative_int("DELPHI_AUTO_REFRESH_MIN_INTERVAL_MS", 1_800_000),
            min_statements=_non_negative_int("DELPHI_AUTO_REFRESH_MIN_STATEMENTS", 5),
            lease_seconds=max(60, _non_negative_int("DELPHI_THEME_LEASE_SECONDS", 600)),
            max_attempts=max(1, _non_negative_int("DELPHI_THEME_MAX_ATTEMPTS", 3)),
            run_retention=max(1, _non_negative_int("DELPHI_THEME_RUN_RETENTION", 10)),
        )


def _database_kwargs() -> dict[str, Any]:
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        return {"dsn": database_url}
    return {
        "host": os.environ.get("DATABASE_HOST", "localhost"),
        "port": int(os.environ.get("DATABASE_PORT", "5432")),
        "dbname": os.environ.get("DATABASE_NAME", "polis"),
        "user": os.environ.get("DATABASE_USER", "postgres"),
        "password": os.environ.get("DATABASE_PASSWORD", ""),
        "sslmode": os.environ.get("DATABASE_SSL_MODE", "prefer"),
    }


def connect():
    kwargs = _database_kwargs()
    if "dsn" in kwargs:
        return psycopg2.connect(kwargs["dsn"])
    return psycopg2.connect(**kwargs)


def _handle_signal(_signum, _frame) -> None:
    global running
    running = False
    logger.info("Shutdown requested")


def maintain_jobs(policy: Policy) -> None:
    """Recover exhausted leases for external-API-managed conversations."""
    with connect() as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE delphi_theme_jobs SET
              status = 'failed',
              processing_revision = NULL,
              updated_at = NOW(),
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = COALESCE(last_error, 'Worker lease expired after final attempt')
            WHERE status = 'processing' AND lease_expires_at < NOW()
              AND attempts >= %s
            """,
            (policy.max_attempts,),
        )


def claim_job(policy: Policy, worker_id: str):
    """Claim one due job and capture its comment snapshot in one transaction."""
    connection = connect()
    try:
        connection.set_session(isolation_level="REPEATABLE READ")
        with connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(
                """
                WITH candidate AS (
                  SELECT j.zid
                  FROM delphi_theme_jobs j
                  WHERE j.source_revision > j.completed_revision
                    AND (
                      j.status IN ('pending', 'failed')
                      OR (j.status = 'processing' AND j.lease_expires_at < NOW())
                    )
                    AND j.attempts < %s
                    AND (j.not_before IS NULL OR j.not_before <= NOW())
                    AND (
                      j.dirty_at <= NOW() - (%s * INTERVAL '1 millisecond')
                      OR j.dirty_since <= NOW() - (%s * INTERVAL '1 millisecond')
                    )
                    AND (
                      j.completed_at IS NULL
                      OR j.completed_at <= NOW() - (%s * INTERVAL '1 millisecond')
                    )
                    AND (
                      SELECT COUNT(*) FROM comments c
                      WHERE c.zid = j.zid AND c.is_meta = false
                        AND COALESCE(c.mod, 0) > -1
                    ) >= %s
                  ORDER BY j.dirty_since, j.zid
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1
                )
                UPDATE delphi_theme_jobs j SET
                  status = 'processing',
                  processing_revision = j.source_revision,
                  started_at = NOW(),
                  updated_at = NOW(),
                  lease_owner = %s,
                  lease_expires_at = NOW() + (%s * INTERVAL '1 second'),
                  attempts = j.attempts + 1,
                  last_error = NULL
                FROM candidate
                WHERE j.zid = candidate.zid
                RETURNING j.*
                """,
                (
                    policy.max_attempts,
                    policy.debounce_ms,
                    policy.max_delay_ms,
                    policy.min_interval_ms,
                    policy.min_statements,
                    worker_id,
                    policy.lease_seconds,
                ),
            )
            job = cursor.fetchone()
            if not job:
                connection.commit()
                return None

            cursor.execute(
                """
                SELECT tid, txt, active, mod
                FROM comments
                WHERE zid = %s AND is_meta = false AND COALESCE(mod, 0) > -1
                  AND txt IS NOT NULL AND BTRIM(txt) <> ''
                ORDER BY tid
                """,
                (job["zid"],),
            )
            comments = [dict(row) for row in cursor.fetchall()]
            connection.commit()
            return dict(job), comments
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


class LeaseHeartbeat:
    def __init__(self, zid: int, worker_id: str, lease_seconds: int):
        self.zid = zid
        self.worker_id = worker_id
        self.lease_seconds = lease_seconds
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, _type, _value, _traceback):
        self.stop_event.set()
        self.thread.join(timeout=2)

    def _run(self) -> None:
        interval = max(20, self.lease_seconds // 3)
        while not self.stop_event.wait(interval):
            try:
                with connect() as connection, connection.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE delphi_theme_jobs SET
                          lease_expires_at = NOW() + (%s * INTERVAL '1 second'),
                          updated_at = NOW()
                        WHERE zid = %s AND status = 'processing'
                          AND lease_owner = %s
                        """,
                        (self.lease_seconds, self.zid, self.worker_id),
                    )
                    if cursor.rowcount != 1:
                        logger.warning("Lost lease for conversation %s", self.zid)
                        return
            except Exception:
                logger.exception("Could not renew lease for conversation %s", self.zid)


def _fallback_layers(vectors: Any) -> list[Any]:
    import numpy as np
    from sklearn.cluster import AgglomerativeClustering, KMeans

    count = len(vectors)
    fine_clusters = min(count, max(2, int(round(math.sqrt(count)))))
    fine = KMeans(n_clusters=fine_clusters, random_state=42, n_init=10).fit_predict(vectors)
    layers = [fine]
    coarse_clusters = max(1, fine_clusters // 2)
    if coarse_clusters < fine_clusters:
        coarse = AgglomerativeClustering(n_clusters=coarse_clusters).fit_predict(vectors)
        layers.append(coarse)
    return layers


def _theme_mode(statement_count: int) -> str:
    # Preserve the historical standard-Docker behavior. Heroku explicitly
    # selects the memory-safe TF-IDF mode in heroku.yml.
    configured = os.environ.get("DELPHI_THEME_EMBEDDING_MODE", "embedding")
    mode = str(configured).strip().lower()
    if mode not in {"tfidf", "embedding", "auto"}:
        logger.warning(
            "Invalid DELPHI_THEME_EMBEDDING_MODE=%r; using embedding", configured
        )
        return "embedding"
    if mode == "auto":
        threshold = _non_negative_int(
            "DELPHI_THEME_EMBEDDING_MAX_STATEMENTS", 128
        )
        return "tfidf" if statement_count <= threshold else "embedding"
    return mode


def _tfidf_theme_projection(texts: list[str]):
    """Build bounded local features without importing the torch stack."""
    import numpy as np
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer

    max_features = _non_negative_int("DELPHI_THEME_TFIDF_MAX_FEATURES", 2048)
    vectorizer = TfidfVectorizer(
        max_features=max(32, max_features),
        stop_words="english",
        ngram_range=(1, 2),
    )
    try:
        matrix = vectorizer.fit_transform(texts)
    except ValueError:
        matrix = None
    if matrix is None or matrix.shape[1] == 0:
        vectors = np.ones((len(texts), 1), dtype=np.float32)
    else:
        components = min(
            max(2, _non_negative_int("DELPHI_THEME_TFIDF_COMPONENTS", 32)),
            max(1, matrix.shape[0] - 1),
            max(1, matrix.shape[1] - 1),
        )
        # Keep the working representation bounded even when a conversation has
        # many comments or distinct terms. TruncatedSVD consumes the sparse
        # matrix and emits only a small dense feature matrix for clustering.
        vectors = TruncatedSVD(
            n_components=components,
            random_state=42,
        ).fit_transform(matrix).astype(np.float32, copy=False)
    if len(vectors) <= 1:
        projection = np.zeros((len(vectors), 2), dtype=np.float32)
    else:
        centered = vectors - vectors.mean(axis=0, keepdims=True)
        left, singular, _ = np.linalg.svd(centered, full_matrices=False)
        components = min(2, left.shape[1])
        projection = np.zeros((len(vectors), 2), dtype=np.float32)
        projection[:, :components] = (
            left[:, :components] * singular[:components]
        ).astype(np.float32, copy=False)
    return vectors, projection


def _cluster_with_embeddings(texts: list[str]):
    global _embedding_model, _embedding_model_path
    import numpy as np
    import evoc
    from sentence_transformers import SentenceTransformer
    from umap import UMAP

    configured_model = os.environ.get("SENTENCE_TRANSFORMER_MODEL")
    bundled_model = "/opt/models/all-MiniLM-L6-v2"
    model_path = configured_model or (
        bundled_model if os.path.isdir(bundled_model) else "all-MiniLM-L6-v2"
    )
    model_identity = configured_model or "all-MiniLM-L6-v2"
    logger.info("Embedding %s statements with %s", len(texts), model_identity)
    if _embedding_model is None or _embedding_model_path != model_path:
        _embedding_model = SentenceTransformer(model_path)
        _embedding_model_path = model_path
        try:
            import torch

            torch.set_num_threads(1)
            torch.set_num_interop_threads(1)
        except (ImportError, RuntimeError):
            pass
    batch_size = max(
        1, _non_negative_int("DELPHI_THEME_EMBEDDING_BATCH_SIZE", 16)
    )
    vectors = np.asarray(
        _embedding_model.encode(
            texts,
            batch_size=batch_size,
            show_progress_bar=False,
            convert_to_numpy=True,
        ),
        dtype=np.float32,
    )
    neighbors = min(15, max(2, len(texts) - 1))
    document_map = UMAP(
        n_components=2,
        n_neighbors=neighbors,
        metric="cosine",
        random_state=42,
    ).fit_transform(vectors)

    try:
        clusterer = evoc.EVoC(min_samples=min(5, max(2, len(texts) // 2)))
        clusterer.fit_predict(vectors)
        layers = [np.asarray(layer) for layer in clusterer.cluster_layers_]
        layers = [
            layer for layer in layers
            if len(layer) == len(texts) and np.any(layer >= 0)
        ]
        if not layers:
            raise ValueError("EVōC returned no usable clusters")
    except Exception:
        logger.exception("EVōC clustering failed; using deterministic fallback")
        layers = _fallback_layers(vectors)

    return vectors, np.asarray(document_map), layers, model_identity


def cluster_comments(comments: list[dict[str, Any]]):
    import numpy as np

    texts = [str(comment["txt"]).strip() for comment in comments]
    tids = [int(comment["tid"]) for comment in comments]
    mode = _theme_mode(len(texts))
    if mode == "tfidf":
        logger.info(
            "Using bounded TF-IDF theme clustering for %s statements",
            len(texts),
        )
        vectors, document_map = _tfidf_theme_projection(texts)
        layers = _fallback_layers(vectors)
        model_identity = "tfidf-v1"
    else:
        logger.info(
            "Using sentence-transformer theme clustering for %s statements",
            len(texts),
        )
        vectors, document_map, layers, model_identity = _cluster_with_embeddings(
            texts
        )
    return texts, tids, vectors, np.asarray(document_map), layers, model_identity


def keyword_labels(texts: list[str], layers: list[np.ndarray]):
    import numpy as np
    from sklearn.feature_extraction.text import TfidfVectorizer

    vectorizer = TfidfVectorizer(
        max_features=2000,
        stop_words="english",
        ngram_range=(1, 2),
    )
    try:
        matrix = vectorizer.fit_transform(texts)
        feature_names = vectorizer.get_feature_names_out()
    except ValueError:
        matrix = None
        feature_names = np.asarray([])

    labels: dict[tuple[int, int], str] = {}
    for layer_id, layer in enumerate(layers):
        for cluster_id in sorted(int(value) for value in np.unique(layer) if value >= 0):
            members = np.where(layer == cluster_id)[0]
            if matrix is None or len(feature_names) == 0:
                labels[(layer_id, cluster_id)] = f"Theme {layer_id + 1}.{cluster_id + 1}"
                continue
            weights = np.asarray(matrix[members].mean(axis=0)).ravel()
            top = [
                str(feature_names[index])
                for index in weights.argsort()[::-1]
                if weights[index] > 0
            ][:5]
            labels[(layer_id, cluster_id)] = " · ".join(top) or f"Theme {layer_id + 1}.{cluster_id + 1}"
    return labels


def build_results(comments: list[dict[str, Any]]):
    import numpy as np

    texts, tids, _vectors, document_map, layers, model_name = cluster_comments(comments)
    labels = keyword_labels(texts, layers)
    themes = []
    assignments = []
    for layer_id, layer in enumerate(layers):
        for cluster_id in sorted(int(value) for value in np.unique(layer) if value >= 0):
            themes.append((layer_id, cluster_id, labels[(layer_id, cluster_id)], "tfidf-keywords-v1"))
            members = np.where(layer == cluster_id)[0]
            centroid = document_map[members].mean(axis=0)
            distances = np.linalg.norm(document_map[members] - centroid, axis=1)
            scale = float(distances.max()) if len(distances) else 0.0
            for member, distance in zip(members, distances, strict=True):
                normalized = float(distance / scale) if scale > 0 else 0.0
                assignments.append(
                    (
                        tids[int(member)],
                        layer_id,
                        cluster_id,
                        max(0.0, min(1.0, 1.0 - normalized)),
                        float(distance),
                    )
                )
    return model_name, themes, assignments


def publish(
    job,
    worker_id: str,
    model_name: str,
    themes,
    assignments,
    run_retention: int,
) -> str:
    run_id = f"auto-theme-{job['zid']}-{job['processing_revision']}-{uuid.uuid4().hex[:8]}"
    with connect() as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO delphi_theme_runs (
              run_id, zid, source_revision, embedding_model, label_method
            ) VALUES (%s, %s, %s, %s, 'tfidf-keywords-v1')
            ON CONFLICT (zid, source_revision) DO NOTHING
            RETURNING run_id
            """,
            (run_id, job["zid"], job["processing_revision"], model_name),
        )
        inserted = cursor.fetchone()
        if inserted:
            execute_values(
                cursor,
                """
                INSERT INTO delphi_themes (
                  run_id, layer_id, cluster_id, topic_name, model_name
                ) VALUES %s
                """,
                [(run_id, *theme) for theme in themes],
            )
            execute_values(
                cursor,
                """
                INSERT INTO delphi_theme_assignments (
                  run_id, tid, layer_id, cluster_id,
                  confidence, distance_to_centroid
                ) VALUES %s
                """,
                [(run_id, *assignment) for assignment in assignments],
            )

        cursor.execute(
            """
            UPDATE delphi_theme_jobs SET
              completed_revision = GREATEST(completed_revision, %s),
              processing_revision = NULL,
              status = CASE WHEN source_revision > %s THEN 'pending' ELSE 'completed' END,
              completed_at = NOW(),
              updated_at = NOW(),
              dirty_since = CASE WHEN source_revision > %s THEN dirty_since ELSE NOW() END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              attempts = 0,
              not_before = NULL,
              last_error = NULL
            WHERE zid = %s AND status = 'processing' AND lease_owner = %s
            """,
            (
                job["processing_revision"],
                job["processing_revision"],
                job["processing_revision"],
                job["zid"],
                worker_id,
            ),
        )
        if cursor.rowcount != 1:
            raise RuntimeError(f"Lost publication lease for conversation {job['zid']}")
        cursor.execute(
            """
            DELETE FROM delphi_theme_runs
            WHERE run_id IN (
              SELECT run_id FROM delphi_theme_runs
              WHERE zid = %s
              ORDER BY generated_at DESC
              OFFSET %s
            )
            """,
            (job["zid"], run_retention),
        )
    return run_id


def fail_job(job, worker_id: str, policy: Policy, error: Exception) -> None:
    retry_delay = min(900, 60 * (2 ** max(0, int(job["attempts"]) - 1)))
    with connect() as connection, connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE delphi_theme_jobs SET
              status = CASE WHEN attempts >= %s THEN 'failed' ELSE 'pending' END,
              processing_revision = NULL,
              updated_at = NOW(),
              not_before = CASE
                WHEN attempts >= %s THEN NULL
                ELSE NOW() + (%s * INTERVAL '1 second')
              END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = %s
            WHERE zid = %s AND status = 'processing' AND lease_owner = %s
            """,
            (
                policy.max_attempts,
                policy.max_attempts,
                retry_delay,
                str(error)[:4000],
                job["zid"],
                worker_id,
            ),
        )


def run_worker() -> None:
    configure_runtime_resources()
    policy = Policy.from_env()
    worker_id = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    logger.info("Starting PostgreSQL theme worker %s with policy %s", worker_id, policy)
    if not policy.enabled:
        logger.info("Automatic theme analysis is disabled by configuration")
        while running:
            time.sleep(5)
        return
    last_maintenance = 0.0
    while running:
        try:
            if time.monotonic() - last_maintenance >= 60:
                maintain_jobs(policy)
                last_maintenance = time.monotonic()
            claimed = claim_job(policy, worker_id)
            if not claimed:
                time.sleep(max(1, policy.poll_interval_seconds))
                continue
            job, comments = claimed
            logger.info(
                "Processing conversation %s revision %s (%s statements)",
                job["zid"],
                job["processing_revision"],
                len(comments),
            )
            try:
                analysis_started = time.monotonic()
                with LeaseHeartbeat(job["zid"], worker_id, policy.lease_seconds):
                    model_name, themes, assignments = build_results(comments)
                    run_id = publish(
                        job,
                        worker_id,
                        model_name,
                        themes,
                        assignments,
                        policy.run_retention,
                    )
                peak_memory_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
                logger.info(
                    "Published run %s with %s themes and %s assignments "
                    "in %.1fs (worker peak RSS %.1f MiB)",
                    run_id,
                    len(themes),
                    len(assignments),
                    time.monotonic() - analysis_started,
                    peak_memory_mb,
                )
            except Exception as error:
                logger.exception("Theme analysis failed for conversation %s", job["zid"])
                fail_job(job, worker_id, policy, error)
        except psycopg2.errors.UndefinedTable:
            logger.error("Theme tables are missing; run the PostgreSQL migration")
            time.sleep(30)
        except Exception:
            logger.exception("Theme worker polling failure")
            time.sleep(max(5, policy.poll_interval_seconds * 3))


def main() -> None:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    run_worker()


if __name__ == "__main__":
    main()
