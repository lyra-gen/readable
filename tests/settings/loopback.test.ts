import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isLoopback } from '../../src/settings/model-picker';

void describe('whether a server address is this computer', () => {
	void test('loopback addresses, with or without a scheme', () => {
		for (const a of ['', 'localhost:11434', 'http://127.0.0.1:1234', 'http://[::1]:8080/v1', 'https://localhost']) assert.equal(isLoopback(a), true, a);
	});

	void test('anything else is another computer', () => {
		for (const a of ['nas.local:11434', 'http://10.0.0.5:1234', 'https://api.example.com', 'localhost.evil.test', '::not a url']) assert.equal(isLoopback(a), false, a);
	});
});
