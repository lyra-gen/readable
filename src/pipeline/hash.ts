/** sha256 hex via Web Crypto; available in the Electron renderer without Node. */
export async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function shortHash(hash: string): string {
	return hash.slice(0, 8);
}
