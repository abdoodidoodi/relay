import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyStatus, parseVersion, supportsNode, writeDependencyMarker } from './start.mjs';

test('startup checks the documented Node minimum without rejecting newer majors', () => {
  assert.deepEqual(parseVersion('v20.19.0'), [20, 19, 0]);
  assert.equal(supportsNode('v20.19.0'), true);
  assert.equal(supportsNode('v20.18.9'), false);
  assert.equal(supportsNode('v22.0.0'), true);
  assert.equal(supportsNode('not-a-version'), false);
});

test('startup refreshes installed packages when either manifest or lockfile changes', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'relay-start-'));
  try {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: { demo: '1.0.0' } }));
    writeFileSync(join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3}');
    mkdirSync(join(projectRoot, 'node_modules', 'demo'), { recursive: true });
    writeFileSync(join(projectRoot, 'node_modules', 'demo', 'package.json'), '{"name":"demo"}');

    const beforeInstall = dependencyStatus(projectRoot);
    assert.equal(beforeInstall.current, false, 'an unmarked checkout receives one locked install');
    writeDependencyMarker(projectRoot, beforeInstall.fingerprint);
    assert.equal(dependencyStatus(projectRoot).current, true);

    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: { demo: '1.0.1' } }));
    assert.equal(dependencyStatus(projectRoot).current, false, 'a changed manifest triggers npm ci');
    const manifestRefresh = dependencyStatus(projectRoot);
    writeDependencyMarker(projectRoot, manifestRefresh.fingerprint);

    writeFileSync(join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3,"updated":true}');
    assert.equal(dependencyStatus(projectRoot).current, false, 'a changed lockfile triggers npm ci');
    const refreshed = dependencyStatus(projectRoot);
    writeDependencyMarker(projectRoot, refreshed.fingerprint);
    assert.equal(dependencyStatus(projectRoot).current, true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
