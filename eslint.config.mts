import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'.test-build',
		'tests/fixtures/files',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'commitlint.config.mjs', 'scripts/*.mjs'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			'obsidianmd/ui/sentence-case': ['warn', { brands: ['Readable', 'Docling'] }],
			'no-restricted-syntax': [
				'error',
				{
					selector: "CallExpression[callee.property.name=/^showAt(MouseEvent|Position)$/]",
					message:
						'Use showMenuForButton (button menus anchor to the button) or showContextMenu (right-click opens at cursor) from src/ui/menu.ts.',
				},
			],
		},
	},
	{
		// Tests run in plain Node, not in an Obsidian window: Node's fetch and globals are the right tools there
		files: ['tests/**/*.ts'],
		languageOptions: { globals: { ...globals.node } },
		rules: {
			'no-restricted-globals': 'off',
			'obsidianmd/no-global-this': 'off',
		},
	},
	{
		// Build and data scripts are Node command-line tools: they print progress and use Node's fetch and timers
		files: ['scripts/**/*.mjs'],
		languageOptions: { globals: { ...globals.node } },
		rules: {
			'no-restricted-globals': 'off',
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/rule-custom-message': 'off',
		},
	},
);
