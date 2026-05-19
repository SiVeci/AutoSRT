# EchoSRT Agent Instructions

This file contains high-signal context for AI agents working in this repository.

## Execution & Deployment Quirks

- **NEVER start the app with `uvicorn` directly.** You MUST start the backend using `python app.py`. The `app.py` script contains a critical `__main__` block that sets `multiprocessing.set_start_method("spawn")`. If bypassed (e.g., via `uvicorn app:app`), the default Linux `fork` mechanism will copy initialized CUDA contexts into child worker processes, resulting in fatal deadlocks and host GPU driver crashes. This applies to both local execution and Docker `CMD` instructions.
- **Docker PUID/PGID Mapping:** The `docker-entrypoint.sh` automatically manages NAS volume permissions by creating and assuming a local user matching the `PUID`/`PGID` environment variables. Do not remove this gosu-based privilege drop mechanism.

## Architecture & Code Boundaries

- **Frontend is strictly No-Build:** The Vue 3 frontend in `frontend/` runs purely on CDN links via native ES modules. There is no `package.json`, no Node.js build step, and no `npm run dev/build`. Make JS/HTML/CSS edits directly in `frontend/` files.
- **Multiprocessing Pipeline:** The backend heavily utilizes a mix of `asyncio.Queue` (in `api/state.py`) and standard Python `multiprocessing.Process`. ASR (Whisper) runs completely isolated in a daemon child process (`core/whisper_engine.py`) to manage heavy VRAM lifecycles and avoid blocking the main event loop.
- **State Persistence:** Task state and pipeline progression are stored as JSON files under `workspace/<task_id>/state.json`. If modifying the pipeline logic (`transcribing` -> `translating`), ensure you respect the state transitions managed in `api/workers/`.