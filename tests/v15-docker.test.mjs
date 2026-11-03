import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts/docker-sim.sh');
const dockerfile = readFileSync(join(root, 'docker/ros-sim/Dockerfile'), 'utf8');
const compose = readFileSync(join(root, 'docker-compose.sim.yml'), 'utf8');

function run(args, opts = {}) {
  return spawnSync('/bin/bash', [script, ...args], {cwd: root, encoding: 'utf8', ...opts});
}

test('Docker stack pins Jazzy/Noble and requires no privileged or host devices', () => {
  assert.match(dockerfile, /FROM ros:jazzy-ros-base-noble/);
  assert.match(dockerfile, /ros-jazzy-ros-gz/);
  assert.match(dockerfile, /ros-jazzy-nav2-bringup/);
  assert.match(compose, /ALEX_ROS_SIMULATION_ONLY: "1"/);
  assert.match(compose, /ROS_DOMAIN_ID: "77"/);
  assert.match(compose, /cap_drop:/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(compose, /^\s*privileged:\s*true\s*$/m);
  assert.doesNotMatch(compose, /^\s*network_mode:\s*host\s*$/m);
  assert.doesNotMatch(compose, /^\s*devices:\s*$/m);
});

test('deployment script has help, strict action validation and valid Bash syntax', () => {
  const syntax = spawnSync('bash', ['-n', script], {encoding: 'utf8'});
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = run(['help']);
  assert.equal(help.status, 0, help.stderr);
  for (const cmd of ['setup','check','preflight','accept','logs','doctor']) assert.match(help.stdout, new RegExp(cmd));
  const invalid = run(['unknown-command']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unknown command/);
});

test('Docker CLI wrapper uses ephemeral single-service run and real acceptance, never reports fake success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-docker-stub-'));
  const log = join(dir, 'calls.log');
  const fake = join(dir, 'docker');
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "$ALEX_FAKE_DOCKER_LOG"\nif [ "$1" = image ] && [ "$2" = inspect ]; then exit 0; fi\nexit 0\n`);
  chmodSync(fake, 0o755);
  const env = {...process.env, PATH: `${dir}:${process.env.PATH}`, ALEX_FAKE_DOCKER_LOG: log};
  try {
    for (const cmd of ['check', 'preflight', 'accept']) {
      const result = run([cmd], {env});
      assert.equal(result.status, 0, `${cmd}: ${result.stderr}`);
    }
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /run --rm -T sim bash -lc/);
    assert.match(calls, /npm test && npm run sim:check/);
    assert.match(calls, /ros-preflight\.py --require/);
    assert.match(calls, /npm run sim:accept/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('missing Docker fails closed and does not claim simulation acceptance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-docker-no-cli-'));
  try {
    const result = run(['preflight'], {env:{...process.env, PATH: dir}});
    // PATH has no bash, but the direct absolute bash executable already launched script.
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Docker is missing/);
  } finally {
    rmSync(dir, {recursive:true, force:true});
  }
});
