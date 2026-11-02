/**
 * What the built-in model server installs. Bump together and re-test.
 * llama.cpp publishes a binary build per platform; the model comes from an
 * ungated Hugging Face repo that ships the vision projector alongside.
 */

/** llama.cpp build tag; v0.8.0 maps to this build: https://github.com/ggml-org/llama.cpp/releases */
export const LLAMA_BUILD = 'b11960';

interface Asset {
	file: string;
	sha256: string;
}

/** CPU builds (Metal on macOS). Checksums are GitHub's asset digests. */
const LLAMA_ASSETS: Record<string, Asset> = {
	'darwin-arm64': { file: `llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`, sha256: '58e5a5e1d7c2bf66cedd9c29e0323f3e570660a70a1e2156d32eed08f4cc1e3c' },
	'darwin-x64': { file: `llama-${LLAMA_BUILD}-bin-macos-x64.tar.gz`, sha256: 'd1e6c9ddcaed9a3b1bb8f3d946bdb3481c7b919357a4029dcb747762397f1da5' },
	'linux-arm64': { file: `llama-${LLAMA_BUILD}-bin-ubuntu-arm64.tar.gz`, sha256: '0065ecfbffe8a790bb0d28059a3320cdc8f723b7f3f248cdc8bfc04790927715' },
	'linux-x64': { file: `llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz`, sha256: '31cc3a6bc638ac6c48dc4b1b74888f1eaadf3d14227c1e5f67daf9a49541d97a' },
	'win32-arm64': { file: `llama-${LLAMA_BUILD}-bin-win-cpu-arm64.zip`, sha256: '77349357c38da235bb0eed37bcc5ecf3efef21bb5dc42c2269589c0e71cfa00f' },
	'win32-x64': { file: `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`, sha256: '73f962f82850d244db47eaacb9d913637027b82399124324298576d58c5f4287' },
};

/** The llama.cpp download for this machine, or null when none is published. */
export function llamaAsset(): (Asset & { url: string }) | null {
	const asset = LLAMA_ASSETS[`${process.platform}-${process.arch}`];
	if (!asset) return null;
	return { ...asset, url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${asset.file}` };
}

export interface ModelFile {
	name: string;
	url: string;
	bytes: number;
	sha256: string;
}

/** A model Readable offers to download, with the vision part that lets it read pictures. */
export interface CatalogModel {
	/** Folder name under the models folder, and the id settings store. */
	id: string;
	name: string;
	/** One sentence for the Models page: what it is good at. */
	blurb: string;
	/** Memory it wants while working, in GB, model and Docling together; shown, and used to recommend. */
	memoryGB: number;
	weights: ModelFile;
	projector: ModelFile;
}

const HF = 'https://huggingface.co';

/**
 * The models on offer, best first: Gemma 4 E4B gave the most accurate
 * summaries, E2B is its smaller sibling, and Qwen3.5 4B writes the most
 * detailed picture descriptions.
 */
export const CATALOG: CatalogModel[] = [
	{
		id: 'gemma-4-e4b',
		name: 'Gemma 4 E4B',
		blurb: 'Best quality in Russian, English and 140+ other languages. Reads pictures.',
		memoryGB: 16,
		weights: {
			name: 'gemma-4-E4B-it-Q4_0.gguf',
			url: `${HF}/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_0.gguf`,
			bytes: 4590807392,
			sha256: 'a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2',
		},
		projector: {
			name: 'mmproj-gemma-4-E4B-it-Q8_0.gguf',
			url: `${HF}/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/mmproj-gemma-4-E4B-it-Q8_0.gguf`,
			bytes: 559874816,
			sha256: '197f49a93027f9843772bd24a6a9e0be2a32a788de5a3def330e9c585d86edd1',
		},
	},
	{
		id: 'gemma-4-e2b',
		name: 'Gemma 4 E2B',
		blurb: 'Faster and smaller, for computers with 8 GB of memory. Reads pictures, less reliably.',
		memoryGB: 8,
		weights: {
			name: 'gemma-4-E2B-it-Q4_0.gguf',
			url: `${HF}/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_0.gguf`,
			bytes: 2841481184,
			sha256: '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
		},
		projector: {
			name: 'mmproj-gemma-4-E2B-it-Q8_0.gguf',
			url: `${HF}/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/mmproj-gemma-4-E2B-it-Q8_0.gguf`,
			bytes: 557368064,
			sha256: '9406f99c16d68cda4f1f0552192dcc99021ea1fc6d2fd50b1dc3ccf30d04b292',
		},
	},
	{
		id: 'qwen3.5-4b',
		name: 'Qwen3.5 4B',
		blurb: 'Most detailed picture descriptions and summaries; slower, and sometimes merges facts.',
		memoryGB: 8,
		weights: {
			name: 'Qwen3.5-4B-Q4_K_M.gguf',
			url: `${HF}/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf`,
			bytes: 2740937888,
			sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
		},
		projector: {
			name: 'mmproj-F16.gguf',
			url: `${HF}/unsloth/Qwen3.5-4B-GGUF/resolve/main/mmproj-F16.gguf`,
			bytes: 672423616,
			sha256: 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864',
		},
	},
];

/** The best model this machine has the memory for. */
export function recommendedModel(totalMemoryGB: number): CatalogModel {
	return CATALOG.find((m) => totalMemoryGB >= m.memoryGB) ?? CATALOG[CATALOG.length - 1]!;
}

export function catalogModel(id: string): CatalogModel | undefined {
	return CATALOG.find((m) => m.id === id);
}

/** Download size of a model and its vision part, in GB, one decimal. */
export function downloadGB(model: CatalogModel): string {
	return ((model.weights.bytes + model.projector.bytes) / 1e9).toFixed(1);
}

/** Tokens of context the server reserves: summary chunks are ~3k tokens, pictures a few hundred each. */
export const CONTEXT_TOKENS = 12288;
