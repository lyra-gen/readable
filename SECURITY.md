# Security

Readable installs software (Docling, Python, llama.cpp and their models) and runs it on your computer, so security reports matter to us.

## Reporting a problem

Report it privately through [GitHub's security advisories](https://github.com/lyra-gen/readable/security/advisories/new), not as a public issue. Include what you found, how to reproduce it and which version you used. We aim to reply within a week.

## Supported versions

Only the latest release gets fixes. Readable updates through Obsidian's community plugins.

## How releases are built

Each release's `main.js` and `styles.css` are built by GitHub Actions from the tagged commit and carry a GitHub artifact attestation. To check one:

```
gh attestation verify main.js --owner lyra-gen
```
