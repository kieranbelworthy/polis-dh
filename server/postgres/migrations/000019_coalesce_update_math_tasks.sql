-- Keep only one unfinished update_math task per conversation and math environment.
--
-- The external API refresh path touches an existing unfinished task instead of
-- inserting an unbounded stream of duplicate refresh requests. This keeps a
-- burst of comments or votes from growing the worker queue without bound.

WITH duplicate_update_math_tasks AS (
  SELECT
    ctid,
    ROW_NUMBER() OVER (
      PARTITION BY math_env, task_type, task_bucket
      ORDER BY created DESC
    ) AS duplicate_rank
  FROM worker_tasks
  WHERE finished_time IS NULL
    AND task_type = 'update_math'
)
UPDATE worker_tasks
SET finished_time = now_as_millis()
FROM duplicate_update_math_tasks
WHERE worker_tasks.ctid = duplicate_update_math_tasks.ctid
  AND duplicate_update_math_tasks.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_tasks_one_unfinished_update_math
ON worker_tasks (math_env, task_type, task_bucket)
WHERE finished_time IS NULL
  AND task_type = 'update_math';
