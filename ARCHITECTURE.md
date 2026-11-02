# Readable architecture

Readable is an Obsidian plugin that turns files in a vault (PDFs, Office documents, images, audio, video, plain text) into Markdown notes that people, Obsidian search and LLM tools can read. This document describes how it works today. Each module's header comment explains that module in more detail; this is the map between them.

## Scope

- **Ingestion only.** Readable reads files and writes notes. Search, retrieval and chat belong to other tools (the README suggests Omnisearch).
- **One note per source file.** The note embeds the file and holds the summary and the full extracted text, so it stays complete if the original is deleted. In the *Under the embed* and *Both* output modes the text is also written below each embed of the file in the user's own notes.
- **Local.** Extraction runs on this computer; AI features use a model server on this computer (Readable's own, or an app such as Ollama or LM Studio). No embeddings or vector database.
- **Desktop only.** It needs Node in Electron's renderer to spawn processes and reach the app-data folder.

## Processes and where state lives

Three processes take part, and only the plugin is always running.

- **The plugin**, inside Obsidian. It owns the queue, the pipeline, every write to the vault and all UI. `src/main.ts` wires it together.
- **The Docling sidecar**, `python/docling_sidecar.py`: one long-lived Python process that Readable installs and starts itself. It speaks JSON-RPC 2.0 over stdin and stdout, one message per line, and exits when stdin closes, so it never outlives Obsidian. It starts on the first Docling job and stops after 10 minutes idle. Requests run on two lanes, each one at a time in arrival order: the *media* lane (audio and video, through Whisper, MLX on Apple Silicon) and the *document* lane (everything else, through Docling's PyTorch models). The two share no models, so a recording is transcribed while a document is read. Only protocol messages go to stdout; Docling's logging goes to stderr, which the plugin keeps for the developer log.
- **Readable's own model server**, a pinned llama.cpp `llama-server` bound to 127.0.0.1 (port 11480, or the next free one). It starts when a request needs it, restarts when a request names another model, and stops after the "keep loaded" idle time. It runs under a small watchdog (`sh` or PowerShell) that kills it when Obsidian's pipe closes, since llama-server cannot notice its parent dying. Other providers are reached the same way, over the OpenAI chat API.

State is split between the vault, which syncs, and a per-user app-data folder (macOS `~/Library/Application Support/Readable`, Windows `%APPDATA%\Readable`, Linux `$XDG_DATA_HOME/readable`), which does not.

| What | Where | Why there |
|---|---|---|
| Notes, saved figures | the vault | The record of what was ingested; must sync and outlive the plugin. |
| Settings | `.obsidian/plugins/readable/data.json` | Obsidian's convention. |
| Queue and job logs | app data, `vaults/<vault id>/queue.json` and `log.jsonl` | Per machine: each machine runs its own jobs and its own Docling. In the vault, sync would merge two machines' queues and both could run one job. |
| Managed Docling | app data: `bin/` (uv, ffmpeg), `venv/`, `python/`, `models/` (HF_HOME), `install.json`, `tmp/` | About 1.6 GB of Python and models that must never sync. |
| PDF checkpoints | app data, `checkpoints/<key>` | Finished page chunks of an interrupted PDF, so a retry resumes. |
| Built-in model server | app data, `llama/` (`build/`, `models/<id>/`, `install.json`) | Several GB of binaries and weights. |

The vault id is Obsidian's own per-vault id, so the queue follows a moved vault.

## From a file to a note

### Triggers

Every trigger ends in `IngestService.enqueue` (`src/core/ingest-service.ts`), implemented by the persistent queue.

- **Watched folder** (`src/watch/vault-watcher.ts`), while auto-ingest is on: a new file is queued at once; a changed file after 60 s of quiet (when reprocessing changes is on); a file moved in from outside the folder only when neither path has a note. At layout ready it backfills once: files in the folder with no note arrived while Obsidian was closed. The default folder is `Readable/Inbox`; empty means the whole vault.
- **Embeds** (`src/watch/attach-watcher.ts`): a file newly embedded in a note is queued, wherever it lives. Only additions count; files are tracked as `TFile` objects, which Obsidian keeps across a rename, so moving an attachment queues nothing.
- **By hand**: the ribbon menu, file explorer menus and command palette, all through `UiActions` (`src/ui/actions.ts`). The queue panel takes drops, but only says that files from outside the vault are not supported yet. `src/ingest/targets.ts` resolves what the user pointed at into file paths and leaves out Readable's own figure files, which would otherwise loop.

### Queue

`PersistentIngestService` (`src/queue/service.ts`) keeps the jobs, persists them through `QueueStore` (`src/queue/store.ts`), and runs each through the pipeline with its own `AbortController`. A file has at most one unfinished job; adding it again retries a failed or cancelled job in place. Jobs can be paused, run next, cancelled, retried, removed or excluded ("Don't process"). The Parallel jobs limit (1 to 4, default 1) applies per lane, using the same split as the sidecar (`laneOf` in `src/extract/kinds.ts`, by extension), so a recording runs beside documents rather than behind them. Old history is pruned on its own: finished jobs keep the newest 200 or the last seven days, whichever keeps more, and failed jobs the newest 500.

### Pipeline stages

`runJob` (`src/pipeline/run-job.ts`) runs one job and never throws; every path becomes an outcome (done, skipped, failed, cancelled). Each stage takes the job's `AbortSignal` and reports its stage and progress.

1. **Ignore list**: an ignored extension is skipped.
2. **Hash and dedupe** (`src/pipeline/hash.ts`): sha256 of the bytes. If this file's output already holds that hash (its note, its blocks below embeds, or both, per the output mode), the job is skipped as already processed.
3. **Detect type** (`src/pipeline/detect.ts`): the MIME type from the bytes via `file-type`; the extension only where sniffing cannot tell. Unknown binary files are skipped as unsupported.
4. **Policy** (`src/extract/kinds.ts`, read through `src/settings/model.ts`): the file's kind (document, image, audio, video, plain text) must be on in Extraction settings, or the job is skipped as off in settings.
5. **Extract** (`src/extract/registry.ts`): Docling for everything it takes; the text reader (`src/extract/text.ts`) only for plain text and JSON, which Docling does not read. There is no fallback. The managed extractor (`src/extract/docling/managed/extractor.ts`) sends a `convert` to the sidecar; the text comes back in a file and is read no further than the note size limit (`src/extract/cap.ts`). The pipeline caps whatever an engine did not cut itself.
6. **Figures** (`src/notes/figures.ts`): pictures the sidecar wrote under app data become attachments named `<document>-figure-<n>.png`, beside the note or in Obsidian's attachment folder, grouped in `<document>-figures/` when grouping is on. Figures from an earlier run of the same file are replaced. Picture descriptions, when on, are made inside the sidecar, which calls the vision model itself (`src/llm/targets.ts` builds what it is handed).
7. **AI enrichment** (`src/llm/enrich.ts`, `src/llm/summarise.ts`): summary (map-reduce over chunks for long text), title and tags, through `LlmClient` (`src/llm/client.ts`). A feature that fails is a warning; the note is written without it.
8. **Write**: `NoteWriter` (`src/notes/writer.ts`) writes the separate note; `InlineWriter` (`src/notes/inline-writer.ts`) writes below each embed. In *Under the embed* mode a file no note embeds gets a separate note instead.

### Outputs

- **Separate note**: frontmatter with the keys in `OWNED_KEYS` (`src/notes/owned.ts`: title, aliases, source, hash, type, date, tags, model, extractor, pages, referenced_by), then the embed, the summary and the full extract, as plain Markdown under a heading or in a folded callout. Where it goes (one folder, beside the file, or a subfolder) is `src/notes/location.ts`; a name taken by another source's note gets a short hash suffix. The fixed text of a note lives in `src/notes/format.ts`.
- **Below embeds**: a folded callout carrying the content hash in an Obsidian comment, or plain Markdown between `%%readable:start sha256:…%%` and `%%readable:end%%`.

The AI commands (`src/ui/ai-commands.ts`, `src/llm/enrich-notes.ts`, `src/notes/enrichment.ts`) run the same enrichment over notes already in the vault, reading the extracted text back from the note, so nothing is extracted again.

## Rules that are easy to get wrong

- **The notes are the record.** A file counts as ingested only when a note's frontmatter has `source: <its path>` and a `hash` starting `sha256:`. `IngestedIndex` (`src/notes/ingested-index.ts`) is derived in memory from Obsidian's metadata cache and never writes; delete a note and its file is no longer ingested. The queue is a work list and can be cleared without losing anything. Output below embeds leaves no frontmatter, so it is not in the index; the hash in its block is its only lasting record.
- **Readable owns part of a note, not all of it.** It rewrites only the `OWNED_KEYS` and the body between `%%readable:start%%` and `%%readable:end%%`. Keys the user added and text outside the markers survive a rewrite. A note missing either marker is never rewritten, however its frontmatter reads: it may be someone else's, so Readable writes a `name (hash).md` beside it. `InlineWriter` is the only code that edits notes Readable did not create, and it changes only its own block, through `vault.process`.
- **Dedupe is by content hash.** Same bytes, same output: a no-op. A changed file reprocesses and replaces its output in place. A file arriving by sync together with its note is a no-op.
- **Moves and renames never reprocess.** `src/notes/follow-rename.ts` rewrites `source` and the embed in the note in place, after Obsidian has finished updating links. The index remembers moved sources until another file takes the old path, the writer updates the note that already covers the source wherever it is, the watcher queues a moved-in file only when neither path has a note, and the attach watcher tracks `TFile` identity. A deleted source leaves its note.
- **Documents never leave the computer, and the document never chooses what the note does.** Extracted text and page pictures go only to the model server the user set (the Address row warns when it is another computer); the sidecar runs with `HF_HUB_OFFLINE=1` except while installing, and reads Docling's models from `models/docling`. Managed Python and uv get an allow-listed environment (`managedEnv`), packages are version-pinned and resolved as of a fixed date against the named index (uv checks each file against the index's sha256), Docling's models are fetched at the commits in `MODEL_REVISIONS` in the sidecar, binaries are sha256-checked, and the sidecar script on disk is compared to the bundled one before every start and run with `python -I`. Figures are taken only from the extractor's own folder and only when their bytes are an image: every other image link in the Markdown, a local path or a URL the document contained, becomes a plain link, and HTML tags that load something are written as text, so opening a note reads no file and fetches nothing. A model's title is one line and frontmatter values escape control characters, so a document cannot talk the model into closing the frontmatter early. The built-in llama-server takes a per-start API key and has no web UI.
- **Two Docling lanes.** Recordings and documents use separate models, so they run side by side; within a lane the sidecar takes one request at a time, so the document lane never reads two PDFs at once (pdfium is not safe to use from two threads). Raising Parallel jobs adds jobs per lane, but a second document waits in the sidecar ("waiting for Docling") and its stall timer starts only when the lane takes it up.
- **PDFs go in chunks and resume.** A PDF is converted 10 pages per pass, with progress and cancel between passes. Each finished chunk (text and figures) is saved under `checkpoints/`, keyed by the file's hash and the options that change the output, so a cancelled, timed-out, crashed or reloaded job resumes. The folder is deleted once the note is written, or after seven days unused.
- **Failures.**
  - *No text*: a file in which extraction finds no text (or only picture placeholders) fails with code `no-text` and a hint for its kind, instead of getting an empty note, so it can be retried or excluded.
  - *Stall timeout*: the Docling timeout counts time without progress, so a long PDF runs as long as its pages advance; a recording, which reports nothing until done, gets at least half its length. On a stall the sidecar is killed (the only way to stop mid-chunk) and the job fails with `docling-timeout`. Killing it also stops the other lane: that request is sent again, up to three times, rather than failed.
  - *Crash*: the job fails with `docling-crash` and the stderr tail in its log. One process exit counts as one crash however many requests it took down; two in a row count as the engine being unavailable.
  - *Engine unavailable* (not installed, still installing, cannot start, repeated crashes): the queue pauses with one notice instead of failing every remaining job; when Docling is not installed the notice offers Install. Once Docling is ready, those jobs are retried and the queue resumes.
  - *AI failures* are warnings, never job failures. A failed job is not retried on its own; Retry and Retry all failed are the user's. A job interrupted by Obsidian closing or a reload starts again at the next load.
  - Old binary Office files (.doc, .xls, .ppt) fail at once with a message, since Docling reads them only through LibreOffice.

## Code map

- `src/main.ts`: the entry point; builds the services, then the UI, then the watchers.
- `src/core/`: shared types (`types.ts`), the `IngestService` interface the UI talks to, abort helpers.
- `src/queue/`: `service.ts` (jobs, worker, lanes, pause, retention), `store.ts` (queue.json and log.jsonl).
- `src/pipeline/`: `run-job.ts` (the stages), `hash.ts`, `detect.ts`.
- `src/extract/`: the `Extractor` contract (`types.ts`), `registry.ts`, `kinds.ts`, `cap.ts`, `text.ts` (plain text and JSON), `docling/` (formats, options, OCR languages, reply mapping) and `docling/managed/` (`installer.ts`, `manager.ts`, `sidecar.ts`, `extractor.ts`, `release.ts` pins).
- `src/llm/`: `client.ts`, `providers.ts`, `models.ts` (Fetch models), `targets.ts`, `prompts.ts`, `enrich.ts`, `summarise.ts`, `enrich-notes.ts`, and `builtin/` for Readable's own server (`installer.ts`, `manager.ts`, `server.ts`, `catalog.ts`, `download.ts`, `gguf.ts`, `release.ts`).
- `src/notes/`: `writer.ts`, `inline-writer.ts`, `owned.ts`, `frontmatter.ts`, `format.ts`, `figures.ts`, `location.ts`, `ingested-index.ts`, `follow-rename.ts`, `enrichment.ts`.
- `src/ingest/`: `targets.ts`, what the user pointed at as file paths.
- `src/watch/`: `vault-watcher.ts` (watched folder), `attach-watcher.ts` (embeds).
- `src/storage/`: `app-data.ts`, the per-user and per-vault folders.
- `src/settings/`: `model.ts` (settings, defaults, validation, migration), `tab.ts` (the declarative settings page), `model-picker.ts`, `connection-tests.ts`.
- `src/ui/`: `queue-view.ts` and `queue-selection.ts` (the queue panel), `status-bar.ts`, `badges.ts`, `bindings.ts`, `commands.ts`, `ai-commands.ts`, `file-menus.ts`, `ingest-menu.ts`, `menu.ts` (placement rules), `notices.ts`, `docling-install.ts`, `llama-install.ts`, `log-modal.ts`, `dev-log.ts`.
- `python/docling_sidecar.py`: the sidecar; its header documents the protocol. Bundled into `main.js` as text and written to app data on install.
- `tests/`: suites by area, run with Node's test runner (`scripts/test.mjs`); `extraction/` needs this machine's managed Docling, `models/` is the opt-in model evaluation, `fixtures/` holds committed sample files and their generator.

## Decisions

- **TypeScript orchestrates, Docling extracts.** Python runs only in the managed sidecar. Node has format routers but nothing with Docling's layout analysis, table structure, reading order and OCR.
- **Docling is the engine, and it is required.** Readable asks to install it at load until it is; there is no fallback reader. Only plain text and JSON, which Docling does not read, go through a small text reader. One engine to support, installed by one button.
- **Readable installs Docling itself**, because the people this is for will not use a terminal. uv brings its own Python into app data, the user's Python is never touched, and every version is pinned (`release.ts`) with dependencies resolved as of a fixed date, so installs are reproducible. The earlier own-server mode (docling-serve over HTTP) was removed: it doubled settings and error paths for nobody.
- **A long-lived sidecar over stdio**, not a process per job and not an HTTP server. Model loading is the cost, so the process stays warm; stdio means no port, no firewall prompt, no HTTP timeouts, and exit on EOF.
- **Readable's own model server is llama-server, not a Node binding.** A native addon would be downloaded at runtime anyway, built for Electron's ABI, and would load gigabytes into Obsidian's process. A separate process is crash-isolated, stoppable and speaks the OpenAI API every other provider uses, which the sidecar's picture descriptions also need. Models come from a small catalog chosen by `tests/models`; any `.gguf` in the user's own folder works too.
- **The AI settings mirror the LLM Wiki plugin** (Provider, Fetch models, Model scope, Custom…), so people using both recognise them.
- **The watched scope is an inbox folder** by default, so the user's own attachments are not ingested unless embedded or chosen.
- **One note per source**, overwritten in its owned region on reprocess. No versioning.
- **Dedupe by content hash**, read from the notes, so clearing the queue never loses it.
- **Queue state in app data, per vault and per machine**: not in `data.json`, which the settings API rewrites, and not in the vault, where sync would merge queues.
- **No native Node modules and no database.** JSON files are enough at this scale; the only runtime dependency is `file-type`.
- **One job at a time by default**, per lane, because local models saturate the machine.
- **Engines never write to the vault.** They return Markdown and files under app data; the writers own every vault write.
- **A deleted source leaves its note.** Deleting the user's data is not Readable's call.
- **No embeddings or vector database in v1.** Plain Markdown is searchable by Obsidian, other plugins and the OS, and readable with the plugin uninstalled.
