import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cargoBin = join(homedir(), '.cargo', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ''}` };
const [mode, ...rest] = process.argv.slice(2);
let program, args;
if (mode === 'native-test' || mode === 'native-check') {
  program = existsSync(join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo'))
    ? join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo') : 'cargo';
  args = [mode === 'native-test' ? 'test' : 'check', '--manifest-path', 'src-tauri/Cargo.toml', ...rest];
} else {
  program = process.execPath;
  const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!existsSync(cli)) { console.error('Run npm ci before starting Relay.'); process.exit(1); }
  args = [cli, ...(mode ? [mode] : []), ...rest];
  if (mode === 'build' && !rest.includes('--bundles') && !rest.includes('--no-bundle')) {
    args.push('--bundles', process.platform === 'win32' ? 'nsis' : process.platform === 'darwin' ? 'dmg' : 'deb');
  }
}
const child = spawn(program, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', (error) => { console.error(`Unable to launch build tool: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
