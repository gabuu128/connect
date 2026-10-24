import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const archive = join(root, 'dist', 'connect.zip');
mkdirSync(dirname(archive), { recursive: true });
const files = ['README.md', 'package.json', 'server.js', 'network', 'public', 'test', 'scripts'];
const command = process.platform === 'win32' ? 'tar' : 'zip';
const args = process.platform === 'win32'
	? ['-a', '-c', '-f', archive, ...files]
	: ['-q', '-r', archive, ...files];
execFileSync(command, args, { cwd: root, stdio: 'inherit' });
console.log(`Created ${archive}`);