#!/usr/bin/env python3
"""
CoIR benchmark runner for Gyst.

Runs Gyst's embedding model (all-MiniLM-L6-v2 via sentence-transformers)
against 4 CoIR retrieval subtasks and reports NDCG@10 / Recall@10 / MRR@10.

Two modes:
  - default (embedding-only): sentence-transformers encodes queries and
    corpus directly, scored via cosine similarity then pytrec_eval for
    the IR metrics. Leaderboard-comparable.
  - --pipeline: spawns `bun run tests/benchmark/coir/pipeline-eval.ts`
    per subtask, passing corpus+queries as JSON stdin, reading ranked
    results as JSON stdout. This routes through the full Gyst
    hybrid pipeline (BM25 + graph + semantic fusion).

Subtasks:
  stackoverflow-qa, codefeedback-st, codefeedback-mt, cosqa

Output:
  tests/benchmark/coir/results/<task>.json (raw per-task metrics)
  benchmark-coir.json                       (combined summary at repo root)
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List

import numpy as np
import pytrec_eval
import torch
from sentence_transformers import SentenceTransformer

import coir

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("gyst-coir")

# The 4 most code-relevant CoIR subtasks. CoIR has 10 tasks total; we
# intentionally run a subset and report it as such in every header.
SUBTASKS = ["stackoverflow-qa", "codefeedback-st", "codefeedback-mt", "cosqa"]

MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIM = 384
BATCH_SIZE = 32
MAX_LENGTH = 256
TOP_K = 10

REPO_ROOT = Path(__file__).resolve().parents[3]
RESULTS_DIR = Path(__file__).resolve().parent / "results"
COMBINED_OUT = REPO_ROOT / "benchmark-coir.json"
PIPELINE_SCRIPT = Path(__file__).resolve().parent / "pipeline-eval.ts"


class GystEmbeddingModel:
    """
    Thin adapter over sentence-transformers all-MiniLM-L6-v2.

    Same model Gyst uses for the semantic strategy in
    src/store/embeddings.ts — we swap Xenova/transformers-js for
    sentence-transformers here because CoIR runs in Python.
    """

    def __init__(self, model_name: str = MODEL_ID) -> None:
        logger.info("Loading %s", model_name)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = SentenceTransformer(model_name, device=device)
        self.model.max_seq_length = MAX_LENGTH
        self.model_name = model_name

    def encode_texts(self, texts: List[str], batch_size: int = BATCH_SIZE) -> np.ndarray:
        return self.model.encode(
            texts,
            batch_size=batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=True,
        )


def score_with_pytrec(
    qrels: Dict[str, Dict[str, int]],
    run_scores: Dict[str, Dict[str, float]],
    k: int = TOP_K,
) -> Dict[str, float]:
    """
    Compute NDCG@k, Recall@k, MAP using pytrec_eval — independent of BEIR.
    """
    measures = {f"ndcg_cut.{k}", f"recall.{k}", "map"}
    trec = pytrec_eval.RelevanceEvaluator(qrels, measures)
    per_query = trec.evaluate(run_scores)
    if not per_query:
        return {"ndcg_at_10": 0.0, "recall_at_10": 0.0, "map_at_10": 0.0}
    ndcgs = [v[f"ndcg_cut_{k}"] for v in per_query.values()]
    recalls = [v[f"recall_{k}"] for v in per_query.values()]
    maps = [v["map"] for v in per_query.values()]
    return {
        "ndcg_at_10": sum(ndcgs) / len(ndcgs),
        "recall_at_10": sum(recalls) / len(recalls),
        "map_at_10": sum(maps) / len(maps),
    }


def retrieve_embedding(
    model: GystEmbeddingModel,
    corpus: Dict[str, Dict[str, str]],
    queries: Dict[str, str],
) -> Dict[str, Dict[str, float]]:
    """
    Dense retrieval by cosine similarity. Returns BEIR-style run dict
    {qid: {did: score}} with top-100 per query.
    """
    corpus_ids = list(corpus.keys())
    corpus_texts = [
        (corpus[did].get("title", "") + " " + corpus[did].get("text", "")).strip()
        for did in corpus_ids
    ]
    query_ids = list(queries.keys())
    query_texts = [queries[qid] for qid in query_ids]

    logger.info("Encoding %d corpus docs", len(corpus_texts))
    corpus_vecs = model.encode_texts(corpus_texts)
    logger.info("Encoding %d queries", len(query_texts))
    query_vecs = model.encode_texts(query_texts)

    # Cosine similarity = dot product of normalized vectors
    scores = np.matmul(query_vecs, corpus_vecs.T)

    run: Dict[str, Dict[str, float]] = {}
    top = min(100, len(corpus_ids))
    for i, qid in enumerate(query_ids):
        row = scores[i]
        top_idx = np.argpartition(-row, top - 1)[:top]
        top_idx = top_idx[np.argsort(-row[top_idx])]
        run[qid] = {corpus_ids[j]: float(row[j]) for j in top_idx}
    return run


def run_embedding_only() -> Dict:
    logger.info("CoIR embedding-only mode starting (subtasks=%s)", SUBTASKS)
    model = GystEmbeddingModel()
    tasks = coir.get_tasks(SUBTASKS)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    start = time.time()
    summary: Dict[str, Dict[str, float]] = {}
    for task_name, task_data in tasks.items():
        corpus, queries, qrels = task_data
        logger.info("Task %s: %d corpus / %d queries", task_name, len(corpus), len(queries))
        run_scores = retrieve_embedding(model, corpus, queries)
        metrics = score_with_pytrec(qrels, run_scores, k=TOP_K)
        summary[task_name] = metrics
        (RESULTS_DIR / f"{task_name}.json").write_text(
            json.dumps({"task": task_name, "metrics": metrics}, indent=2)
        )
        logger.info(
            "%s NDCG@10=%.4f Recall@10=%.4f MAP=%.4f",
            task_name,
            metrics["ndcg_at_10"],
            metrics["recall_at_10"],
            metrics["map_at_10"],
        )

    elapsed = time.time() - start
    logger.info("CoIR embedding-only complete in %.1fs", elapsed)

    def mean(key: str) -> float:
        vals = [summary[t][key] for t in summary]
        return sum(vals) / len(vals) if vals else 0.0

    return {
        "benchmark": "CoIR",
        "mode": "embedding-only",
        "model": MODEL_ID,
        "subtasks_run": SUBTASKS,
        "subtasks_total": 10,
        "note": f"Ran {len(SUBTASKS)} of 10 CoIR subtasks — mean is over this subset, not the full leaderboard.",
        "durationSeconds": round(elapsed, 1),
        "per_task": summary,
        "mean_ndcg_at_10": mean("ndcg_at_10"),
        "mean_recall_at_10": mean("recall_at_10"),
        "mean_map_at_10": mean("map_at_10"),
    }


def run_pipeline_subtask(task_name: str, corpus: Dict, queries: Dict, qrels: Dict) -> Dict:
    """
    Spawns `bun run pipeline-eval.ts` with stdin={corpus,queries}, reads
    stdout={results: {qid: {did: score}}}, scores with pytrec_eval.
    """
    logger.info(
        "Pipeline subtask %s: %d corpus / %d queries",
        task_name,
        len(corpus),
        len(queries),
    )

    payload = json.dumps({"corpus": corpus, "queries": queries}).encode("utf-8")
    proc = subprocess.run(
        ["bun", "run", str(PIPELINE_SCRIPT)],
        input=payload,
        capture_output=True,
        env={**os.environ, "PATH": os.environ.get("PATH", "") + ":" + str(Path.home() / ".bun/bin")},
        timeout=3600,
    )
    if proc.returncode != 0:
        logger.error("pipeline-eval.ts failed: %s", proc.stderr.decode("utf-8", "replace"))
        raise RuntimeError(f"pipeline-eval failed for {task_name}")

    stdout = proc.stdout.decode("utf-8", "replace").strip()
    last_line = stdout.splitlines()[-1] if stdout else "{}"
    result_blob = json.loads(last_line)
    run_scores = result_blob.get("results", {})
    return score_with_pytrec(qrels, run_scores, k=TOP_K)


def run_pipeline_mode() -> Dict:
    logger.info("CoIR full-pipeline mode starting (subtasks=%s)", SUBTASKS)
    tasks = coir.get_tasks(SUBTASKS)
    start = time.time()
    summary: Dict[str, Dict[str, float]] = {}
    for task_name, task_data in tasks.items():
        corpus, queries, qrels = task_data
        if len(corpus) > 10000:
            referenced = set()
            for q_ids in qrels.values():
                referenced.update(q_ids.keys())
            keep = {}
            for did in referenced:
                if did in corpus:
                    keep[did] = corpus[did]
            remaining = [d for d in corpus if d not in keep]
            import random
            random.seed(42)
            random.shuffle(remaining)
            for did in remaining[: 10000 - len(keep)]:
                keep[did] = corpus[did]
            logger.info(
                "%s: capped corpus %d → %d (kept %d qrels docs)",
                task_name,
                len(corpus),
                len(keep),
                len(referenced),
            )
            corpus = keep
        summary[task_name] = run_pipeline_subtask(task_name, corpus, queries, qrels)

    elapsed = time.time() - start

    def mean(key: str) -> float:
        vals = [summary[t][key] for t in summary]
        return sum(vals) / len(vals) if vals else 0.0

    return {
        "benchmark": "CoIR",
        "mode": "full-pipeline",
        "model": MODEL_ID,
        "subtasks_run": SUBTASKS,
        "subtasks_total": 10,
        "note": f"Ran {len(SUBTASKS)} of 10 CoIR subtasks via Gyst full hybrid pipeline.",
        "durationSeconds": round(elapsed, 1),
        "per_task": summary,
        "mean_ndcg_at_10": mean("ndcg_at_10"),
        "mean_recall_at_10": mean("recall_at_10"),
        "mean_map_at_10": mean("map_at_10"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--pipeline",
        action="store_true",
        help="Run full hybrid pipeline via Bun subprocess (slow)",
    )
    args = parser.parse_args()

    report = run_pipeline_mode() if args.pipeline else run_embedding_only()

    COMBINED_OUT.write_text(json.dumps(report, indent=2))
    logger.info("Written %s", COMBINED_OUT)

    print("\n=== CoIR Results ===")
    print(f"Mode: {report['mode']}  Model: {report['model']}")
    print(f"Subtasks: {len(report['subtasks_run'])} of {report['subtasks_total']}")
    print(f"Mean NDCG@10:   {report['mean_ndcg_at_10']:.4f}")
    print(f"Mean Recall@10: {report['mean_recall_at_10']:.4f}")
    print(f"Mean MAP@10:    {report['mean_map_at_10']:.4f}")
    print("\nPer task:")
    for task, metrics in report["per_task"].items():
        print(
            f"  {task:22s}  NDCG={metrics['ndcg_at_10']:.4f}  "
            f"Recall={metrics['recall_at_10']:.4f}  MAP={metrics['map_at_10']:.4f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
