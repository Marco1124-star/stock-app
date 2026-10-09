"""Bounded background jobs. Only a child process downloads/trains the model."""
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from .structure_neural import VERSION


class StructureJobs:
    def __init__(self, root=None):
        self.root = Path(root or Path(__file__).resolve().parents[1] / ".ml-cache" / "structure-jobs")
        self.jobs = {}
        self.lock = Lock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="structure-job")

    def submit(self, symbol, payload):
        identity = hashlib.sha256(json.dumps([VERSION, symbol, payload], sort_keys=True, allow_nan=False).encode()).hexdigest()
        with self.lock:
            for job in self.jobs.values():
                if job["identity"] == identity and (job["status"] in ("queued", "running") or
                    (job["status"] == "complete" and time.time() - job["updated"] < 1800) or
                    (job["status"] == "failed" and time.time() - job["updated"] < 30)):
                    return self.public(job)
            if sum(j["status"] in ("queued", "running") for j in self.jobs.values()) >= 3:
                raise RuntimeError("Coda piena: attendi il completamento delle analisi già avviate.")
            for key in list(self.jobs):
                if self.jobs[key]["status"] not in ("queued", "running") and time.time() - self.jobs[key]["updated"] > 1800:
                    del self.jobs[key]
            if len(self.jobs) >= 64:
                oldest = next((k for k, j in self.jobs.items() if j["status"] not in ("queued", "running")), None)
                if oldest:
                    del self.jobs[oldest]
            job = {"jobId": uuid.uuid4().hex, "identity": identity, "symbol": symbol,
                   "status": "queued", "updated": time.time(), "result": None}
            self.jobs[job["jobId"]] = job
            self.executor.submit(self._run, job, payload)
            return self.public(job)

    def public(self, job):
        return {key: job[key] for key in ("jobId", "symbol", "status", "result", "error") if key in job}

    def get(self, symbol, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return self.public(job) if job and job["symbol"] == symbol else None

    def _run(self, job, payload):
        directory = self.root / job["identity"]
        try:
            directory.mkdir(parents=True, exist_ok=True)
            output = directory / "result.json"
            if output.exists() and time.time() - output.stat().st_mtime < 1800:
                result = json.loads(output.read_text(encoding="utf-8"))
                if result.get("version") != VERSION or result.get("requestedSymbol") != job["symbol"]:
                    raise ValueError("Cached result identity mismatch")
            else:
                with self.lock:
                    job["status"] = "running"
                source = directory / "request.json"
                source.write_text(json.dumps({"symbol": job["symbol"], "payload": payload}, allow_nan=False), encoding="utf-8")
                env = os.environ.copy()
                env.update(OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1",
                           STRUCTURE_ARTIFACT_DIR=str(directory / "models"))
                command = [sys.executable, "-m", "ml.structure_worker", str(source), str(output)]
                with (directory / "worker.log").open("w", encoding="utf-8") as log:
                    subprocess.run(command, cwd=Path(__file__).resolve().parents[1], env=env, stdout=log,
                                   stderr=subprocess.STDOUT, timeout=600, check=True,
                                   creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS) if os.name == "nt" else 0)
                result = json.loads(output.read_text(encoding="utf-8"))
            with self.lock:
                job.update(status="complete", result=result, updated=time.time())
        except Exception as exc:
            message = ("Tempo massimo superato (10 minuti). Nessuna previsione pubblicata." if isinstance(exc, subprocess.TimeoutExpired)
                       else "Analisi non completata: storico, connessione o dipendenze non disponibili. Consulta il log del job.")
            with self.lock:
                job.update(status="failed", error=message, updated=time.time())


jobs = StructureJobs()
