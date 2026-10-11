#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cargoBin = join(homedir(), '.cargo', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ''}` };
const minimumNode = [20, 19, 0];

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
  return match ? match.slice(1).map(Number) : null;
}

export function supportsNode(value, minimum = minimumNode) {
  const current = parseVersion(value);
  if (!current) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

export function dependencyStatus(projectRoot = root) {
  let packageJsonText;
  let packageLockText;
  try {
    packageJsonText = readFileSync(join(projectRoot, 'package.json'), 'utf8');
    packageLockText = readFileSync(join(projectRoot, 'package-lock.json'), 'utf8');
  } catch {
    return { current: false, missingPackages: ['package.json or package-lock.json'], fingerprint: null };
  }
  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonText);
  } catch {
    return { current: false, missingPackages: ['valid package.json'], fingerprint: null };
  }
  const fingerprint = createHash('sha256').update(packageJsonText).update('\0').update(packageLockText).digest('hex');
  const packages = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const missingPackages = Object.keys(packages).filter((name) => !existsSync(join(projectRoot, 'node_modules', ...name.split('/'), 'package.json')));
  let installedFingerprint = '';
  try {
    installedFingerprint = readFileSync(join(projectRoot, 'node_modules', '.relay-lock-hash'), 'utf8').trim();
  } catch {
    // Install once when upgrading from a checkout that predates this marker.
  }
  return { current: missingPackages.length === 0 && installedFingerprint === fingerprint, missingPackages, fingerprint };
}

export function writeDependencyMarker(projectRoot = root, fingerprint = dependencyStatus(projectRoot).fingerprint) {
  if (!fingerprint) throw new Error('Cannot record dependencies without package.json and package-lock.json');
  const modulesDir = join(projectRoot, 'node_modules');
  mkdirSync(modulesDir, { recursive: true });
  writeFileSync(join(modulesDir, '.relay-lock-hash'), `${fingerprint}\n`, 'utf8');
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
  });
}

function commandWorks(command, args = ['--version']) {
  const result = spawn(command, args, { env, stdio: 'ignore', windowsHide: true });
  return new Promise((resolveCheck) => {
    result.once('error', () => resolveCheck(false));
    result.once('exit', (code) => resolveCheck(code === 0));
  });
}

async function doctor() {
  const checks = [];
  const nodeOk = supportsNode(process.version);
  checks.push([nodeOk, `Node.js ${process.version} (requires 20.19.0 or newer)`]);

  const rustOk = await commandWorks('rustc');
  const cargoOk = await commandWorks('cargo');
  checks.push([rustOk && cargoOk, `Rust toolchain: ${rustOk && cargoOk ? 'available' : 'missing'}`]);

  let appleToolsOk = true;
  if (process.platform === 'darwin') {
    appleToolsOk = await commandWorks('xcode-select', ['-p']);
    checks.push([appleToolsOk, `Xcode Command Line Tools: ${appleToolsOk ? 'available' : 'missing'}`]);
  }

  const dependencies = dependencyStatus();
  checks.push([dependencies.current, `JavaScript dependencies: ${dependencies.current ? 'current' : 'missing or out of date'}`]);

  for (const [ok, message] of checks) console.log(`${ok ? '✓' : '✗'} ${message}`);
  if (process.platform === 'win32') {
    console.log('Windows also needs Visual Studio 2022 C++ Build Tools (Desktop development with C++) and the WebView2 Runtime.');
  }
  if (!nodeOk) console.error('Install Node.js 22 LTS from https://nodejs.org/, then reopen this terminal.');
  if (!rustOk || !cargoOk) console.error('Install the stable Rust toolchain from https://rustup.rs/, then reopen this terminal.');
  if (!appleToolsOk) console.error('Install Apple Command Line Tools with: xcode-select --install');
  if (!dependencies.current) console.error('Run npm start to install or refresh the locked JavaScript dependencies with npm ci.');
  if (process.platform === 'win32') {
    console.log('Setup details: https://v2.tauri.app/start/prerequisites/');
  } else if (process.platform === 'darwin') {
    console.log('Setup details: https://v2.tauri.app/start/prerequisites/');
  }
  return checks.every(([ok]) => ok);
}

async function main(args) {
  if (!supportsNode(process.version)) {
    console.error(`Relay requires Node.js 20.19.0 or newer; found ${process.version}.`);
    console.error('Install Node.js 22 LTS from https://nodejs.org/, then reopen this terminal.');
    return 1;
  }
  if (args.includes('--doctor')) return await doctor() ? 0 : 1;

  const dependencies = dependencyStatus();
  if (!dependencies.current) {
    console.log('Installing or refreshing Relay JavaScript dependencies from package-lock.json (npm ci)…');
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let code;
    try {
      code = await run(npmCommand, ['ci'], { cwd: root, env, shell: process.platform === 'win32' });
    } catch {
      console.error('Could not start npm. Install Node.js 22 LTS, reopen this terminal, and retry npm start.');
      return 1;
    }
    if (code !== 0) return code;
    try {
      writeDependencyMarker(root, dependencies.fingerprint);
    } catch (error) {
      console.error(`Could not record the installed dependency lock: ${error.message}`);
      return 1;
    }
  }

  const rustOk = await commandWorks('rustc') && await commandWorks('cargo');
  if (!rustOk) {
    console.error('Relay needs the stable Rust toolchain to build its desktop runtime.');
    console.error('Install it from https://rustup.rs/, reopen this terminal, and retry npm start.');
    return 1;
  }
  if (process.platform === 'darwin' && !await commandWorks('xcode-select', ['-p'])) {
    console.error('Relay needs Apple Command Line Tools. Install them with: xcode-select --install');
    return 1;
  }
  if (process.platform === 'win32') {
    console.log('Building the local desktop app. If Tauri reports a missing Windows toolchain, install Visual Studio 2022 C++ Build Tools and WebView2: https://v2.tauri.app/start/prerequisites/');
  }
  return await run(process.execPath, [join(root, 'scripts', 'relay-tool.mjs'), 'dev', ...args], { cwd: root, env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Relay could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
