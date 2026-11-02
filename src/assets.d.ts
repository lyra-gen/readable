/** Python sources are bundled as text (esbuild loader `.py: 'text'`). */
declare module '*.py' {
	const source: string;
	export default source;
}
