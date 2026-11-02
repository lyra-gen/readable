/**
 * Versions managed mode installs. Bump together and re-test: a new Docling or
 * Python marks existing installs out of date, and updating reinstalls from
 * scratch. A new base add-on (baseAddons in installer.ts) also marks them out
 * of date but is added in place. A new uv or package pin reaches only new
 * installs and add-ons; a changed sidecar script is rewritten at load without
 * reinstalling.
 */

/** uv, the installer: https://github.com/astral-sh/uv/releases */
export const UV_VERSION = '0.12.24';

export const DOCLING_VERSION = '2.138.0';

/**
 * Passed to `uv pip install --exclude-newer`, so Docling's dependencies
 * resolve to what existed when we tested, not whatever was published since.
 * uv checks each file it downloads against the sha256 the index publishes.
 */
export const RESOLVE_CUTOFF = '2026-10-13T00:00:00Z';

export const PYTHON_VERSION = '3.12';

/** Static ffmpeg for the speech add-on, as a wheel: https://pypi.org/project/imageio-ffmpeg/ */
export const FFMPEG_PACKAGE = 'imageio-ffmpeg==0.6.0';

/** Opens HEIC/HEIF/AVIF (iPhone photos) in Pillow, so the sidecar can hand Docling a PNG. */
export const HEIF_PACKAGE = 'pillow-heif==1.8.1';

/**
 * Add-ons, as Docling extras so their versions resolve against the pinned
 * Docling. `speech`: Whisper (MLX on Apple Silicon). `ocrmac`: Apple Vision
 * OCR through PyObjC, Mac only, no models to download. `rapidocr`: the ONNX
 * runtime RapidOCR needs for its per-language models (the base install has
 * only its torch backend, which reads Chinese and English). `opendocument`:
 * odfdo, for .odt/.ods/.odp, which Docling's standard install leaves out.
 */
export const ADDON_PACKAGES = {
	speech: [`docling[asr]==${DOCLING_VERSION}`, FFMPEG_PACKAGE],
	ocrmac: [`docling[ocrmac]==${DOCLING_VERSION}`],
	rapidocr: [`docling[rapidocr]==${DOCLING_VERSION}`],
	opendocument: [`docling-slim[format-opendocument]==${DOCLING_VERSION}`],
} as const;

interface UvAsset {
	file: string;
	sha256: string;
}

/** Keyed by `${process.platform}-${process.arch}`. Checksums from the release's .sha256 files. */
const UV_ASSETS: Record<string, UvAsset> = {
	'darwin-arm64': {
		file: 'uv-aarch64-apple-darwin.tar.gz',
		sha256: '0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732',
	},
	'darwin-x64': {
		file: 'uv-x86_64-apple-darwin.tar.gz',
		sha256: '4fa82e37cb94767661f532b001e470b67a186c7260e305bd84ddb78fd545c0b6',
	},
	'win32-x64': {
		file: 'uv-x86_64-pc-windows-msvc.zip',
		sha256: '7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019',
	},
	'win32-arm64': {
		file: 'uv-aarch64-pc-windows-msvc.zip',
		sha256: '4b783bda5cc44bbae0651a837223873a7acee31152381aef5fc86ef6bef25997',
	},
	'linux-x64': {
		file: 'uv-x86_64-unknown-linux-gnu.tar.gz',
		sha256: 'b4dfaef47d491a7296981f8374a4595f55dbf84e8937c8ecd2983574d8bb3da6',
	},
	'linux-arm64': {
		file: 'uv-aarch64-unknown-linux-gnu.tar.gz',
		sha256: '5231be65f496304623895dacdbf1de8504fec90303684bdf05805aa34414dd21',
	},
};

/** The uv download for this machine, or null when uv publishes none. */
export function uvAsset(): (UvAsset & { url: string }) | null {
	const asset = UV_ASSETS[`${process.platform}-${process.arch}`];
	if (!asset) return null;
	return { ...asset, url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.file}` };
}
