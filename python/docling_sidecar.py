"""Readable's Docling sidecar.

The plugin starts this script with the Python Readable installed and talks to
it with JSON-RPC 2.0 over stdin/stdout, one message per line (as LSP and MCP
servers do over stdio, minus the Content-Length headers). It exits as soon as
stdin closes, so it never outlives Obsidian, even after a crash.

Requests (plugin -> sidecar):
  convert(path, output_path?,
          options: {kind, ocr, table_mode, chunk_pages, images_dir,
                    checkpoint_dir, language, timestamps, vision,
                    describe_pictures, describe_image})
      ocr: {mode, languages, engine}. mode is "auto" (pages without a text
      layer), "all" (every page) or "off". languages are BCP-47 tags in
      order of preference. engine is "auto", "ocrmac" or "rapidocr"; the
      engine's Python package must be installed (the plugin's add-ons).
      vision: {url, api_key, model, prompt} of an OpenAI-compatible server. With
      describe_pictures, pictures inside documents get a description from
      it (Docling's picture-description stage). With describe_image, a
      standalone image gets one directly, since the layout model may not
      see a photo as a "picture".
      -> {status, markdown, errors, pages, seconds, markdown_path?}
      With output_path, any Markdown is written to that file and the reply
      has markdown "" and markdown_path instead, so a huge text is not one
      huge stdout line.
      A PDF is converted chunk_pages pages at a time, with progress and
      cancel between chunks; other files in one pass.
      kind is "document" (default), "image", "audio" or "video". Audio goes
      through Whisper; video has its audio track pulled out with ffmpeg first.
      Both need the speech add-on (docling[asr] and ffmpeg on PATH).
      With images_dir, pictures are written there as PNG files and the
      markdown references them by absolute path; the plugin moves them
      into the vault and deletes the folder.
      With checkpoint_dir, each finished chunk of a PDF is saved there, and
      chunks already saved are not converted again: a convert that was
      cancelled, timed out or killed resumes where it stopped. The plugin
      names the folder after the file's content and the options that change
      the output, and deletes it once the note is written.
      status is Docling's (success, partial_success, failure, skipped) or
      "cancelled". The field names are docling-serve's, which the plugin maps.
  download(ocr?, addon?) -> null
      fetch the default models into READABLE_DOCLING_MODELS (the plugin's
      models folder; converts read them from there, and the plugin runs this
      process with HF_HUB_OFFLINE=1 except while installing). With addon "speech", load the
      Whisper model instead; with addon "rapidocr" (or at base install, with
      ocr), run the OCR engine once so its language models are fetched. Fails
      when no installed engine reads the languages, so the plugin can say so.
  warmup(options) -> null  load the models for these options now (Whisper
      for kind "audio" or "video", else the PDF models)

Requests run on two lanes, each one at a time in arrival order: audio and
video converts, their warmup and the speech add-on's download on the media
lane; everything else on the document lane. Whisper (MLX on Apple Silicon) and
the document models (PyTorch) share nothing, so a recording is transcribed
while a document is read. Only the document lane touches _converters, only the
media lane _asr_converters. Two documents never convert at once: Docling's PDF
backend (pdfium) is not thread-safe, see docling-project/docling#1191.

Notifications (plugin -> sidecar):
  cancel(id)             stop that convert between page chunks

Notifications (sidecar -> plugin):
  ready(versions)        sent once at start
  started(id)            a lane took the request up
  progress(id, done, total, detail?, seconds?)
      done/total: pages, done counting chunks read earlier on a resume.
      detail: a step in words. seconds: a recording's length.

Only protocol messages go to stdout: the real stdout is kept for them and
sys.stdout points at stderr, so a library that prints cannot corrupt the
stream. Docling's logging also goes to stderr; the plugin keeps it for the dev
log.
"""

import json
import logging
import os
import queue
import sys
import threading
import time
import traceback

PROTOCOL = 1

# JSON-RPC error codes: the reserved ones, plus ours in the server range
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603

_protocol_out = sys.stdout
sys.stdout = sys.stderr

_out_lock = threading.Lock()
_cancelled = set()
_cancel_lock = threading.Lock()
_lanes = {"document": queue.Queue(), "media": queue.Queue()}
_converters = {}

MEDIA_KINDS = ("audio", "video")


def lane_of(method, params):
    """The lane a request runs on; see the module docstring. Malformed params fail on the document lane."""
    if not isinstance(params, dict):
        return "document"
    if method == "download":
        return "media" if params.get("addon") == "speech" else "document"
    options = params.get("options")
    return "media" if isinstance(options, dict) and options.get("kind") in MEDIA_KINDS else "document"


def _write(message):
    line = json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False)
    with _out_lock:
        _protocol_out.write(line + "\n")
        _protocol_out.flush()


def notify(method, params):
    _write({"method": method, "params": params})


def reply(request_id, result):
    _write({"id": request_id, "result": result})


def reply_error(request_id, code, message):
    _write({"id": request_id, "error": {"code": code, "message": message}})


def is_cancelled(request_id):
    with _cancel_lock:
        return request_id in _cancelled


DESCRIBE_PROMPT = (
    "Describe this image in two or three sentences for someone who cannot see it. "
    "Say what it shows and any text in it. No preamble."
)
# Sampling for both description paths, and how long each may take (seconds).
# Thinking is off: a thinking model (Gemma 4 in LM Studio) spends the reply cap
# thinking and describes nothing.
VISION_PARAMS = {"max_tokens": 200, "temperature": 0.2, "reasoning_effort": "none"}
PICTURE_DESCRIBE_TIMEOUT = 120
IMAGE_DESCRIBE_TIMEOUT = 180


def result(status, markdown, errors, pages, started, ocr=True):
    """The convert reply, with docling-serve's field names. `ocr`: collect OCR warnings, which only documents have."""
    return {
        "status": status,
        "markdown": markdown,
        "errors": errors + (ocr_warnings.drain() if ocr else []),
        "pages": pages,
        "seconds": time.monotonic() - started,
    }


class OcrWarnings(logging.Handler):
    """Docling only logs it when an engine drops some of the OCR languages; that belongs in the job log."""

    def __init__(self):
        super().__init__(logging.WARNING)
        self.records = []
        logging.getLogger("docling.models.base_ocr_model").addHandler(self)

    def emit(self, record):
        message = record.getMessage()
        if "ignoring" in message:
            self.records.append({"component_type": "ocr", "module_name": "", "error_message": message.replace("iso:", "")})

    def drain(self):
        found, self.records = self.records, []
        return found


ocr_warnings = OcrWarnings()


def remove_quietly(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def ocr_key(ocr):
    """The convert `ocr` option as a hashable key; the legacy bool means auto/all-defaults or off."""
    if not isinstance(ocr, dict):
        return ("auto" if ocr else "off", (), "auto")
    return ocr.get("mode", "auto"), tuple(ocr.get("languages") or []), ocr.get("engine", "auto")


def ocr_options_for(mode, languages, engine):
    """Docling's OCR options for the plugin's choice, or None when OCR is off."""
    if mode == "off":
        return None
    from docling.datamodel.pipeline_options import OcrAutoOptions, OcrMacOptions, OcrMode, RapidOcrOptions

    # Docling reads a BCP-47 tag only behind `iso:`; a bare value is an engine's own code
    tags = [f"iso:{tag}" if ":" not in tag else tag for tag in languages]
    common = {"lang": tags, "mode": OcrMode.FULL_PAGE if mode == "all" else OcrMode.DEFAULT}
    if engine == "ocrmac":
        return OcrMacOptions(**common)
    if engine == "rapidocr":
        return RapidOcrOptions(backend="onnxruntime", **common)
    return OcrAutoOptions(**common)


def models_dir():
    """Where the plugin keeps Docling's models, once they are there (READABLE_DOCLING_MODELS)."""
    folder = os.environ.get("READABLE_DOCLING_MODELS")
    return folder if folder and os.path.isdir(folder) else None


def converter_for(ocr, table_mode, pictures=False, vision=None):
    """One converter per option set; Docling caches its loaded models on it. `vision` adds picture descriptions."""
    vision_key = (vision or {}).get("url"), (vision or {}).get("model"), (vision or {}).get("prompt")
    key = (ocr_key(ocr), table_mode, pictures, vision_key)
    if key in _converters:
        return _converters[key]
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, PictureDescriptionApiOptions, TableFormerMode
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    options = PdfPipelineOptions()
    if models_dir():
        # Read the models downloaded at install; never resolve them over the network
        options.artifacts_path = models_dir()
    ocr_options = ocr_options_for(*ocr_key(ocr))
    options.do_ocr = ocr_options is not None
    if ocr_options is not None:
        options.ocr_options = ocr_options
    options.do_table_structure = True
    # Keep the pictures the layout model finds, at 2x for legible figures
    options.generate_picture_images = pictures or bool(vision)
    options.images_scale = 2.0
    if vision:
        headers = {"Authorization": f"Bearer {vision['api_key']}"} if vision.get("api_key") else {}
        options.enable_remote_services = True
        options.do_picture_description = True
        options.picture_description_options = PictureDescriptionApiOptions(
            url=vision["url"].rstrip("/") + "/chat/completions",
            headers=headers,
            params={"model": vision["model"], **VISION_PARAMS},
            prompt=vision.get("prompt") or DESCRIBE_PROMPT,
            timeout=PICTURE_DESCRIBE_TIMEOUT,
            concurrency=1,
        )
    options.table_structure_options.mode = (
        TableFormerMode.FAST if table_mode == "fast" else TableFormerMode.ACCURATE
    )
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
        }
    )
    _converters[key] = converter
    return converter


_asr_converters = {}


def document_converter(options):
    """The converter `convert` uses for these options, so `warmup` loads the same one."""
    images_dir = options.get("images_dir") or None
    vision = options.get("vision") or None
    kind = options.get("kind") or "document"
    describe_pictures = bool(vision) and bool(options.get("describe_pictures")) and kind == "document"
    return converter_for(
        options.get("ocr", True), options.get("table_mode", "accurate"), bool(images_dir), vision if describe_pictures else None
    )


def initialize(converter, input_format):
    """Loads the pipeline's models now; an OCR language no engine serves becomes a plain message for the user."""
    from docling.exceptions import OcrLanguageNotSupportedError

    try:
        converter.initialize_pipeline(input_format)
    except OcrLanguageNotSupportedError as error:
        logging.warning("OCR language not supported:\n%s", error)
        raise RuntimeError(
            "No installed OCR engine reads the OCR languages set under Extraction > Documents. "
            "Install Apple Vision OCR or RapidOCR there, or change the languages."
        ) from None


def prefetch_ocr(ocr):
    """Runs OCR once on a generated image so the engine downloads its language models now, not during a job."""
    import tempfile

    from docling.datamodel.base_models import InputFormat
    from PIL import Image, ImageDraw

    converter = converter_for(ocr, "fast")
    initialize(converter, InputFormat.IMAGE)
    image = Image.new("RGB", (320, 80), "white")
    ImageDraw.Draw(image).text((16, 28), "Readable 2026", fill="black")
    fd, png = tempfile.mkstemp(prefix="readable-ocr-", suffix=".png")
    os.close(fd)
    try:
        image.save(png)
        converter.convert(png, raises_on_error=True)
    finally:
        remove_quietly(png)


def asr_converter_for(language):
    """One Whisper converter per language; Docling picks MLX on Apple Silicon, native Whisper elsewhere."""
    if language in _asr_converters:
        return _asr_converters[language]
    from docling.datamodel import asr_model_specs
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import AsrPipelineOptions
    from docling.document_converter import AudioFormatOption, DocumentConverter
    from docling.pipeline.asr_pipeline import AsrPipeline

    asr = asr_model_specs.WHISPER_TURBO.model_copy()
    pinned = model_folder(WHISPER_MLX_REPO)
    if asr.repo_id == WHISPER_MLX_REPO and pinned and os.path.isdir(pinned):
        # The snapshot downloaded at install, so nothing is resolved over the network
        asr.repo_id = pinned
    if language:
        asr.language = language
    converter = DocumentConverter(
        format_options={
            InputFormat.AUDIO: AudioFormatOption(pipeline_cls=AsrPipeline, pipeline_options=AsrPipelineOptions(asr_options=asr)),
        }
    )
    _asr_converters[language] = converter
    return converter


def extract_audio(video_path):
    """The audio track of a video as a 16 kHz mono WAV in a temp file; the caller deletes it."""
    import subprocess
    import tempfile

    fd, wav = tempfile.mkstemp(prefix="readable-", suffix=".wav")
    os.close(fd)
    # -nostdin: ffmpeg would otherwise read keypresses from our stdin, the plugin's request pipe
    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", video_path, "-vn", "-ac", "1", "-ar", "16000", wav],
        check=True,
        stdin=subprocess.DEVNULL,
    )
    return wav


def clock(seconds):
    """83.4 → 01:23; 3723 → 1:02:03."""
    total = int(seconds)
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def transcript_markdown(document, timestamps):
    """One paragraph per segment; segment times are metadata, so they are rendered here as `[mm:ss]`."""
    from docling_core.types.doc import TextItem

    lines = []
    for item, _level in document.iterate_items():
        if not isinstance(item, TextItem) or not item.text.strip():
            continue
        # Segment times are TrackSource entries in `source` (a list in this Docling version)
        sources = getattr(item, "source", None) or []
        if not isinstance(sources, list):
            sources = [sources]
        start = next((getattr(src, "start_time", None) for src in sources if getattr(src, "start_time", None) is not None), None)
        if timestamps and start is not None:
            lines.append(f"[{clock(start)}] {item.text.strip()}")
        else:
            lines.append(item.text.strip())
    return "\n\n".join(lines) if lines else document.export_to_markdown(compact_tables=True)


HEIF_SUFFIXES = (".heic", ".heif", ".avif")


# Docling scales a picture up about 3x for layout and OCR, and Pillow refuses
# anything over 179 million pixels: a 20-megapixel phone photo already fails.
# Past this side length a photo is scaled down first; OCR still reads it well.
IMAGE_MAX_SIDE = 4000


def prepared_image(path):
    """
    A temp copy Docling can read, or None when the file is fine as it is. The
    caller deletes it. HEIC/HEIF/AVIF: Docling's image reader does not open
    them. Camera JPEGs of type MPO hold extra frames (a preview, a depth map)
    that Docling reads as pages and fails on: only the main picture is kept.
    Photos too large for Docling are scaled down. Multi-page TIFFs (scans)
    are left alone.
    """
    import tempfile

    from PIL import Image, ImageOps

    heif = path.lower().endswith(HEIF_SUFFIXES)
    if heif:
        import pillow_heif

        pillow_heif.register_heif_opener()
    with Image.open(path) as img:
        pages = getattr(img, "n_frames", 1) if img.format != "MPO" else 1
        if not heif and img.format != "MPO" and (pages > 1 or max(img.size) <= IMAGE_MAX_SIDE):
            return None
        # Upright as the camera meant it: the copy loses the EXIF orientation
        frame = ImageOps.exif_transpose(img)
        transparent = "A" in frame.mode or (frame.mode == "P" and "transparency" in frame.info)
        frame = frame.convert("RGBA" if transparent else "RGB")
        frame.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))
        fd, out = tempfile.mkstemp(prefix="readable-", suffix=".png" if transparent else ".jpg")
        os.close(fd)
        frame.save(out, format="PNG" if transparent else "JPEG", quality=95)
    return out


def media_length(path):
    """How long a recording is in seconds; None when ffmpeg cannot say."""
    import re
    import subprocess

    try:
        probe = subprocess.run(["ffmpeg", "-nostdin", "-i", path], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"Duration: (\d+):(\d\d):(\d\d)", probe.stderr)
    if not match:
        return None
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3))


def recording_label(seconds):
    """1234 → "a 21-minute recording"."""
    if seconds < 90:
        return f"a {seconds}-second recording"
    minutes = round(seconds / 60)
    return f"a {minutes}-minute recording" if minutes < 90 else f"a {seconds / 3600:.1f}-hour recording"


def transcribe(request_id, path, options, started):
    """Audio or video → transcript; status fields match the document path."""
    language = (options.get("language") or "").strip()
    converter = asr_converter_for(language)
    length = media_length(path)
    if length:
        # No progress from Whisper; the length tells the user what to expect, and the plugin how long to allow
        notify("progress", {"id": request_id, "done": 0, "total": 0, "detail": recording_label(length), "seconds": length})
    audio_path = path
    temp = None
    if options.get("kind") == "video":
        temp = audio_path = extract_audio(path)
    try:
        if is_cancelled(request_id):
            return result("cancelled", "", [], None, started, ocr=False)
        converted = converter.convert(audio_path, raises_on_error=False)
    finally:
        if temp:
            remove_quietly(temp)
    markdown = transcript_markdown(converted.document, bool(options.get("timestamps", True))) if converted.document else ""
    # The document lane's OCR warnings stay for its own reply
    return result(status_of(converted), markdown, errors_of(converted), None, started, ocr=False)


def export_markdown(document, images_dir, chunk):
    """Markdown for one conversion result; with images_dir, pictures become files referenced by absolute path.

    Tables are compact (no padding to align columns): they render the same and
    a big spreadsheet comes out several times smaller.
    """
    if not images_dir:
        return document.export_to_markdown(compact_tables=True)
    import re
    from pathlib import Path
    from docling_core.types.doc import ImageRefMode

    out_dir = Path(images_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / f"chunk{chunk}.md"
    document.save_as_markdown(md_path, artifacts_dir=out_dir / f"chunk{chunk}", image_mode=ImageRefMode.REFERENCED, compact_tables=True)
    text = md_path.read_text(encoding="utf-8")
    md_path.unlink()

    def absolute(match):
        # Only Docling's own figure files become absolute links; a link the document itself
        # contains (a URL, or a path such as ../../.ssh/id_rsa) is left as it is, for the
        # plugin to keep as text
        target = match.group(2)
        if target.startswith(("http:", "https:", "data:", "/")):
            return match.group(0)
        resolved = Path(os.path.normpath(out_dir / target))
        if not resolved.resolve().is_relative_to(out_dir.resolve()) or not resolved.is_file():
            return match.group(0)
        return f"![{match.group(1)}]({resolved})"

    return re.sub(r"!\[([^\]]*)\]\(([^)\s]+)\)", absolute, text)


# Formats every vision server takes in a data URL; anything else is converted first.
# LM Studio refuses `data:image/webp` although it decodes WebP.
VISION_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png"}
# Vision models scale pictures down to about 1000 px anyway; this keeps requests small
VISION_MAX_SIDE = 2048


def image_for_vision(path):
    """(mime, bytes) to send: the file itself when it is a JPEG or PNG of moderate size, else a converted copy."""
    import io

    from PIL import Image

    with Image.open(path) as img:
        if img.format in VISION_FORMATS and max(img.size) <= VISION_MAX_SIDE:
            with open(path, "rb") as f:
                return VISION_FORMATS[img.format], f.read()
        transparent = "A" in img.mode or (img.mode == "P" and "transparency" in img.info)
        img = img.convert("RGBA" if transparent else "RGB")
        img.thumbnail((VISION_MAX_SIDE, VISION_MAX_SIDE))
        out = io.BytesIO()
        if transparent:
            img.save(out, format="PNG")
            return "image/png", out.getvalue()
        img.save(out, format="JPEG", quality=90)
        return "image/jpeg", out.getvalue()


def describe_image(path, vision):
    """One chat call with the image attached; returns the description text."""
    import base64
    import urllib.error

    mime, raw = image_for_vision(path)
    data = base64.b64encode(raw).decode("ascii")
    body = {
        "model": vision["model"],
        **VISION_PARAMS,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": vision.get("prompt") or DESCRIBE_PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}},
                ],
            }
        ],
    }
    headers = {"Content-Type": "application/json"}
    if vision.get("api_key"):
        headers["Authorization"] = f"Bearer {vision['api_key']}"
    url = vision["url"].rstrip("/") + "/chat/completions"
    try:
        status, reply = post_json(url, body, headers)
        if status == 400 and "reasoning" in json.dumps(reply).lower():
            # A server that does not know reasoning_effort says so with a 400; ask again without it
            body.pop("reasoning_effort", None)
            status, reply = post_json(url, body, headers)
    except urllib.error.URLError as error:
        raise RuntimeError(f"Couldn't reach the model server for the vision model: {error.reason}") from None
    if status >= 400:
        # Surface the server's own message ("model 'x' not found") rather than a bare status
        error = reply.get("error") if isinstance(reply, dict) else None
        detail = error.get("message", error) if isinstance(error, dict) else error or str(reply)[:300]
        raise RuntimeError(f"Vision model request failed (HTTP {status}): {detail}")
    return (reply["choices"][0]["message"]["content"] or "").strip()


def post_json(url, body, headers):
    """POSTs JSON; returns (status, parsed reply), the reply as text when it is not JSON. Errors come back, not raised."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=IMAGE_DESCRIBE_TIMEOUT) as res:
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    text = raw.decode("utf-8", "replace")
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def pdf_page_count(path):
    try:
        import pypdfium2

        pdf = pypdfium2.PdfDocument(path)
        try:
            return len(pdf)
        finally:
            pdf.close()
    except Exception:
        return None


def errors_of(result):
    return [
        {
            "component_type": str(getattr(e, "component_type", "") or ""),
            "module_name": str(getattr(e, "module_name", "") or ""),
            "error_message": str(getattr(e, "error_message", "") or ""),
        }
        for e in (result.errors or [])
    ]


def status_of(result):
    status = result.status
    return status.value if hasattr(status, "value") else str(status)


# A document is as good as its worst chunk.
_RANK = {"failure": 3, "partial_success": 2, "skipped": 1, "success": 0}


def convert(request_id, params):
    from docling.datamodel.base_models import InputFormat

    path = params["path"]
    options = params.get("options") or {}
    started = time.monotonic()
    if options.get("kind") in ("audio", "video"):
        return transcribe(request_id, path, options, started)
    # Old .doc/.xls/.ppt: Docling has LibreOffice convert them, and reads the command from here on each file.
    # The plugin finds it (Obsidian's PATH is too bare for Docling's own lookup); every document request sets it.
    libreoffice = options.get("libreoffice")
    if libreoffice:
        os.environ["DOCLING_LIBREOFFICE_CMD"] = libreoffice
    else:
        os.environ.pop("DOCLING_LIBREOFFICE_CMD", None)
    if options.get("kind") == "image" or path.lower().endswith(HEIF_SUFFIXES):
        prepared = prepared_image(path)
        if prepared:
            try:
                return convert(request_id, {**params, "path": prepared})
            finally:
                remove_quietly(prepared)
    chunk = max(1, int(options.get("chunk_pages") or 5))
    images_dir = options.get("images_dir") or None
    vision = options.get("vision") or None
    kind = options.get("kind") or "document"
    converter = document_converter(options)
    initialize(converter, InputFormat.PDF)
    if kind == "image" and vision and options.get("describe_image"):
        # The whole picture, described directly; OCR text (if any) follows below.
        # A failed description leaves the text: the file fails only when there is nothing at all.
        description, problems = "", []
        try:
            description = describe_image(path, vision)
        except Exception as error:
            logging.warning("Describing %s failed: %s", path, error)
            problems.append({"component_type": "vision", "module_name": "", "error_message": f"No picture description: {error}"})
        converted = converter.convert(path, raises_on_error=False)
        text = export_markdown(converted.document, images_dir, 0).strip() if converted.document else ""
        text = "" if text == "<!-- image -->" else text
        status = "success" if description or text else status_of(converted)
        if problems:
            status = "partial_success" if description or text else "failure"
        return result(
            status,
            "\n\n".join(part for part in (description, text) if part),
            problems + errors_of(converted),
            1,
            started,
        )

    if is_cancelled(request_id):
        return result("cancelled", "", [], None, started)

    total = pdf_page_count(path) if path.lower().endswith(".pdf") else None
    if not total:
        # Not a PDF, or unreadable as one: a single pass, no page progress
        converted = converter.convert(path, raises_on_error=False)
        return result(
            status_of(converted),
            export_markdown(converted.document, images_dir, 0) if converted.document else "",
            errors_of(converted),
            len(converted.pages or []) or None,
            started,
        )

    checkpoint = Checkpoint(options.get("checkpoint_dir"), chunk)
    ranges = [(first, min(total, first + chunk - 1)) for first in range(1, total + 1, chunk)]
    saved = checkpoint.saved(len(ranges))
    parts, errors, worst = [], [], "success"
    notify("progress", {"id": request_id, "done": ranges[saved - 1][1] if saved else 0, "total": total})
    for index, (first, last) in enumerate(ranges):
        if is_cancelled(request_id):
            return result("cancelled", "", [], total, started)
        part = checkpoint.load(index) if index < saved else None
        if part is None:
            converted = converter.convert(path, raises_on_error=False, page_range=(first, last))
            text = export_markdown(converted.document, images_dir, index).strip() if converted.document else ""
            part = {"status": status_of(converted), "errors": errors_of(converted), "text": text}
            checkpoint.save(index, part)
        if _RANK.get(part["status"], 3) > _RANK[worst]:
            worst = part["status"]
        errors.extend(part["errors"])
        if part["text"]:
            parts.append(part["text"])
        notify("progress", {"id": request_id, "done": last, "total": total})

    # Some chunks failed but others produced text: partial, not a failure
    if worst == "failure" and parts:
        worst = "partial_success"
    return result(worst, "\n\n".join(parts), errors, total, started)


class Checkpoint:
    """A PDF's finished chunks on disk, so an interrupted convert resumes: one JSON file per chunk.

    The chunk size is part of the file names, so chunks of another size are never mixed in.
    Without a folder, nothing is saved.
    """

    def __init__(self, folder, chunk):
        self.folder = folder
        self.chunk = chunk
        if folder:
            os.makedirs(folder, exist_ok=True)

    def _path(self, index):
        return os.path.join(self.folder, f"pages{self.chunk}-{index}.json")

    def saved(self, count):
        """How many chunks from the start are already saved."""
        done = 0
        while self.folder and done < count and os.path.exists(self._path(done)):
            done += 1
        return done

    def load(self, index):
        try:
            with open(self._path(index), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def save(self, index, part):
        if not self.folder:
            return
        # Written whole or not at all: a kill mid-write must not leave half a chunk to resume from
        tmp = self._path(index) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(part, f, ensure_ascii=False)
        os.replace(tmp, self._path(index))


def download(_request_id, params):
    params = params or {}
    addon = params.get("addon")
    if addon == "speech":
        # Builds the pipeline, which fetches the Whisper model into HF_HOME
        from docling.datamodel.base_models import InputFormat

        download_whisper_mlx()
        asr_converter_for("").initialize_pipeline(InputFormat.AUDIO)
        return None
    if addon == "rapidocr":
        prefetch_ocr({**(params.get("ocr") or {}), "engine": "rapidocr"})
        return None
    if addon:
        return None
    download_pinned_models()
    if params.get("ocr"):
        prefetch_ocr(params["ocr"])
    return None


# The exact commit of each model Docling loads, resolved from the refs its
# specs name (`main`, `v2.3.0`) on 2026-10-31. Docling itself would fetch
# whatever those refs point to today; pinning means a later change to a repo
# cannot change what a document is read with until this table is updated.
# All weights are safetensors or ONNX, so a swapped model could misread
# documents but not run code. Folder names follow Docling's artifacts layout.
MODEL_REVISIONS = {
    "docling-project/docling-layout-heron": "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8",
    "docling-project/docling-layout-heron-onnx": "40bde044036bb181c130ddf6c51792187268748f",
    "docling-project/docling-models": "fc0f2d45e2218ea24bce5045f58a389aed16dc23",
    "docling-project/DocumentFigureClassifier-v2.5": "f859dfbff5c9916cd996942d4b0db7fa25808220",
    "docling-project/CodeFormulaV2": "ecedbe111d15c2dc60bfd4a823cbe80127b58af4",
}

# Whisper for Apple Silicon (mlx-whisper), pinned the same way; loaded from
# the folder when it is there, else mlx-whisper fetches `main` itself.
WHISPER_MLX_REPO = "mlx-community/whisper-turbo"
WHISPER_MLX_REVISION = "ec8e501925a1e2e85b082740a208c37ff6c4f59a"


def download_whisper_mlx():
    """The MLX Whisper model at its pinned commit, when this machine would use it (Apple Silicon with mlx-whisper)."""
    from docling.datamodel import asr_model_specs

    folder = model_folder(WHISPER_MLX_REPO)
    if not folder or asr_model_specs.WHISPER_TURBO.repo_id != WHISPER_MLX_REPO:
        return
    from pathlib import Path

    from docling.models.utils.hf_model_download import download_hf_model

    download_hf_model(repo_id=WHISPER_MLX_REPO, revision=WHISPER_MLX_REVISION, local_dir=Path(folder), progress=False)


def model_folder(repo_id):
    """Where a repo's snapshot lives under READABLE_DOCLING_MODELS, in Docling's `org--name` layout."""
    target = os.environ.get("READABLE_DOCLING_MODELS")
    return os.path.join(target, repo_id.replace("/", "--")) if target else None


def download_pinned_models():
    """Docling's default models at their pinned commits, into the plugin's models folder; RapidOCR's through Docling."""
    from pathlib import Path

    from docling.models.utils.hf_model_download import download_hf_model
    from docling.utils.model_downloader import download_models

    target = os.environ.get("READABLE_DOCLING_MODELS")
    if not target:
        download_models(progress=False)
        return
    for repo_id, revision in MODEL_REVISIONS.items():
        download_hf_model(repo_id=repo_id, revision=revision, local_dir=Path(model_folder(repo_id)), progress=False)
    # RapidOCR's ONNX models (no Hugging Face repo to pin); everything else is above
    download_models(
        output_dir=Path(target),
        progress=False,
        with_layout=False,
        with_tableformer=False,
        with_code_formula=False,
        with_picture_classifier=False,
    )


def warmup(_request_id, params):
    from docling.datamodel.base_models import InputFormat

    options = params.get("options") or {}
    if options.get("kind") in MEDIA_KINDS:
        asr_converter_for((options.get("language") or "").strip()).initialize_pipeline(InputFormat.AUDIO)
        return None
    initialize(document_converter(options), InputFormat.PDF)
    return None


def versions(_request_id=None, _params=None):
    from importlib.metadata import PackageNotFoundError, version

    found = {"protocol": PROTOCOL, "python": sys.version.split()[0]}
    for name in ("docling", "docling-core", "torch"):
        try:
            found[name] = version(name)
        except PackageNotFoundError:
            pass
    return found


def convert_to_file(request_id, params):
    """
    convert, with the Markdown written to params["output_path"] when the
    plugin gives one, and only the path in the reply. A large document
    (a 25 MB CSV becomes 0.4 GB of Markdown) would otherwise be one huge line
    on stdout, which the plugin reads and parses on Obsidian's main thread.
    """
    out = convert(request_id, params)
    output_path = params.get("output_path")
    markdown = out.get("markdown") or ""
    if not output_path or not markdown:
        return out
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(markdown)
    return {**out, "markdown": "", "markdown_path": output_path}


METHODS = {"convert": convert_to_file, "download": download, "warmup": warmup}


def worker(work):
    """Runs one lane's requests one at a time, in arrival order."""
    while True:
        request_id, method, params = work.get()
        try:
            # Requests wait here while another on their lane runs; the plugin shows that and starts its timeout now
            notify("started", {"id": request_id})
            reply(request_id, METHODS[method](request_id, params))
        except Exception as error:
            logging.error("%s failed:\n%s", method, traceback.format_exc())
            reply_error(request_id, INTERNAL_ERROR, f"{type(error).__name__}: {error}")
        finally:
            with _cancel_lock:
                _cancelled.discard(request_id)


def handle(message):
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or "method" not in message:
        reply_error(message.get("id") if isinstance(message, dict) else None, INVALID_REQUEST, "Invalid request")
        return
    method = message["method"]
    params = message.get("params") or {}
    if method == "cancel":
        with _cancel_lock:
            _cancelled.add(params.get("id"))
        return
    if "id" not in message:
        return  # unknown notification: ignore, as JSON-RPC requires
    if method not in METHODS:
        reply_error(message["id"], METHOD_NOT_FOUND, f"Unknown method: {method}")
        return
    _lanes[lane_of(method, params)].put((message["id"], method, params))


def main():
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    for work in _lanes.values():
        threading.Thread(target=worker, args=(work,), daemon=True).start()
    notify("ready", versions())
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            reply_error(None, PARSE_ERROR, "Parse error")
            continue
        handle(message)
    # stdin closed: Obsidian quit, crashed or stopped us. Exit even mid-conversion.
    os._exit(0)


if __name__ == "__main__":
    main()
