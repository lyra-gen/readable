import { promises as fs } from 'fs';

/**
 * Reads the few metadata values Readable needs from a GGUF model file's
 * header, without loading the model: the architecture and the context length
 * it was trained for. Format: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

const MAGIC = 0x46554747; // "GGUF", little-endian
const CHUNK = 1 << 20;

/** Value types in GGUF metadata. */
const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, Bool: 7, Str: 8, Arr: 9, U64: 10, I64: 11, F64: 12 } as const;

/** Byte size of each fixed-size type. */
const FIXED_SIZE: Record<number, number> = { [T.U8]: 1, [T.I8]: 1, [T.Bool]: 1, [T.U16]: 2, [T.I16]: 2, [T.U32]: 4, [T.I32]: 4, [T.F32]: 4, [T.U64]: 8, [T.I64]: 8, [T.F64]: 8 };

/** Sequential reads over a file handle, a chunk at a time. */
class Reader {
	private buf = Buffer.alloc(0);
	private offset = 0;
	private filePos = 0;

	constructor(private readonly file: fs.FileHandle) {}

	private async need(n: number): Promise<void> {
		while (this.buf.length - this.offset < n) {
			const chunk = Buffer.alloc(Math.max(CHUNK, n));
			const { bytesRead } = await this.file.read(chunk, 0, chunk.length, this.filePos);
			if (bytesRead === 0) throw new Error('Unexpected end of GGUF file');
			this.filePos += bytesRead;
			this.buf = Buffer.concat([this.buf.subarray(this.offset), chunk.subarray(0, bytesRead)]);
			this.offset = 0;
		}
	}

	async u32(): Promise<number> {
		await this.need(4);
		const v = this.buf.readUInt32LE(this.offset);
		this.offset += 4;
		return v;
	}

	async u64(): Promise<number> {
		await this.need(8);
		const v = Number(this.buf.readBigUInt64LE(this.offset));
		this.offset += 8;
		return v;
	}

	async string(): Promise<string> {
		const len = await this.u64();
		await this.need(len);
		const v = this.buf.toString('utf8', this.offset, this.offset + len);
		this.offset += len;
		return v;
	}

	async skip(n: number): Promise<void> {
		// Large arrays (the tokenizer's vocabulary) are skipped a chunk at a time
		while (n > 0) {
			const step = Math.min(n, CHUNK);
			await this.need(step);
			this.offset += step;
			n -= step;
		}
	}

	/** A scalar as a number (integers and floats), or null for other types. */
	async number(type: number): Promise<number | null> {
		const size = FIXED_SIZE[type];
		if (size === undefined) return null;
		await this.need(size);
		const b = this.buf;
		const o = this.offset;
		this.offset += size;
		switch (type) {
			case T.U8:
			case T.Bool:
				return b.readUInt8(o);
			case T.I8:
				return b.readInt8(o);
			case T.U16:
				return b.readUInt16LE(o);
			case T.I16:
				return b.readInt16LE(o);
			case T.U32:
				return b.readUInt32LE(o);
			case T.I32:
				return b.readInt32LE(o);
			case T.F32:
				return b.readFloatLE(o);
			case T.U64:
				return Number(b.readBigUInt64LE(o));
			case T.I64:
				return Number(b.readBigInt64LE(o));
			case T.F64:
				return b.readDoubleLE(o);
			default:
				return null;
		}
	}

	async skipValue(type: number): Promise<void> {
		if (type === T.Str) {
			await this.skip(await this.u64());
			return;
		}
		if (type === T.Arr) {
			const inner = (await this.u32());
			const count = await this.u64();
			const size = FIXED_SIZE[inner];
			if (size !== undefined) await this.skip(size * count);
			else for (let i = 0; i < count; i++) await this.skipValue(inner);
			return;
		}
		const size = FIXED_SIZE[type];
		if (size === undefined) throw new Error(`Unknown GGUF value type ${type}`);
		await this.skip(size);
	}
}

export interface GgufInfo {
	architecture: string | null;
	/** The context length the model was trained for, in tokens; null when the file does not say. */
	contextLength: number | null;
}

/** The architecture and trained context length of a GGUF file; nulls when unreadable. */
export async function readGgufInfo(path: string): Promise<GgufInfo> {
	const info: GgufInfo = { architecture: null, contextLength: null };
	let file: fs.FileHandle | null = null;
	try {
		file = await fs.open(path, 'r');
		const r = new Reader(file);
		if ((await r.u32()) !== MAGIC) return info;
		const version = await r.u32();
		if (version < 2) return info;
		await r.u64(); // tensor count
		const count = await r.u64();
		const contexts = new Map<string, number>();
		for (let i = 0; i < count; i++) {
			const key = await r.string();
			const type = (await r.u32());
			if (key === 'general.architecture' && type === T.Str) {
				info.architecture = await r.string();
			} else if (key.endsWith('.context_length')) {
				const value = await r.number(type);
				if (value !== null) contexts.set(key, value);
				else await r.skipValue(type);
			} else {
				await r.skipValue(type);
			}
			const found = info.architecture !== null ? contexts.get(`${info.architecture}.context_length`) : undefined;
			if (found !== undefined) {
				info.contextLength = found;
				return info;
			}
		}
		return info;
	} catch {
		return info;
	} finally {
		await file?.close();
	}
}
