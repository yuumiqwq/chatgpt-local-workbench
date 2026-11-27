#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { acquireLock, atomicJson, deploy, DeploymentError, loadConfig } from './deploy-windows.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const defer = message => { throw new DeploymentError('BUSY', message, 2); };

export async function autoDeploy(file, { signal, runDeploy = deploy, retryFailed = false } = {}) {
  const spec = read(file);
  if (spec.version !== 1 || spec.hostname !== hostname()) throw new DeploymentError('CONFIG', 'Automatic deployment belongs to another host.');
  const config = loadConfig(spec.deployment_config);
  if (!config.releases) throw new DeploymentError('CONFIG', 'Automatic deployment requires isolated releases.');
  mkdirSync(config.stateDirectory, { recursive: true });
  const stateFile = join(config.stateDirectory, 'automatic.json');
  const failureFile = join(config.stateDirectory, 'automatic-failure.json');
  const report = { at: new Date().toISOString(), pid: process.pid, status: 'checking' };
  const save = () => atomicJson(stateFile, report);
  const release = acquireLock(join(config.stateDirectory, 'automatic.lock'), 'automatic deployment');
  const owner = JSON.stringify({ purpose: 'workbench-auto-deploy', hostname: hostname(), pid: process.pid });
  let phoneLock, pauseOwned = false;
  try {
    save();
    // Optional dependency maintenance is independent of release/guardian state.
    // Explicit mode keeps deploy(check) free of installation side effects.
    const dependencies = await runDeploy(spec.deployment_config, 'ensure-desktop', { signal });
    report.agent_desktop = dependencies.agent_desktop;
    const checked = await runDeploy(spec.deployment_config, 'check', { signal });
    report.target = checked.target;
    if (!checked.deployment_needed) {
      // A manual apply may already have validated and activated this candidate.
      if (existsSync(failureFile)) unlinkSync(failureFile);
      report.status = 'up-to-date'; return report;
    }
    const failure = existsSync(failureFile) ? read(failureFile) : null;
    if (!retryFailed && failure?.scope === config.scope && failure.target === checked.target) {
      report.status = 'blocked-failed-candidate';
      report.failure = failure;
      return report;
    }
    const beforeActivate = async ({ target }) => {
      report.target = target;
      if (spec.phone_state_directory) {
        const phone = realpathSync(spec.phone_state_directory);
        phoneLock = join(phone, 'operation.lock');
        try { mkdirSync(phoneLock); }
        catch (error) { phoneLock = undefined; if (error.code === 'EEXIST') defer('Phone operation is active.'); throw error; }
        writeFileSync(join(phoneLock, 'pid'), String(process.pid));
        const lease = existsSync(join(phone, 'lease.json')) ? read(join(phone, 'lease.json')) : null;
        const drag = existsSync(join(phone, 'drag.json')) ? read(join(phone, 'drag.json')) : null;
        if (existsSync(join(phone, 'PAUSED')) || lease?.expires > Date.now() || drag) defer('Phone control is active or paused.');
      }
      if (spec.guardian) {
        if (existsSync(spec.guardian.pause_file)) defer('Runtime guardian is already paused for maintenance.');
        const pausedAt = Date.now();
        writeFileSync(spec.guardian.pause_file, owner, { flag: 'wx' });
        pauseOwned = true;
        report.status = 'waiting-for-guardian'; save();
        let acknowledged = false;
        for (let attempt = 0; attempt < 25; attempt++) {
          const state = read(spec.guardian.state_file);
          if (state.paused === true && Date.parse(state.at) >= pausedAt) { acknowledged = true; break; }
          await delay(2000, undefined, { signal });
        }
        if (!acknowledged) defer('Runtime guardian did not acknowledge maintenance.');
      }
      report.status = 'activating'; save();
    };
    report.status = 'preparing'; save();
    const result = await runDeploy(spec.deployment_config, 'apply', { signal, beforeActivate, expectedTarget: checked.target,
      onEvent: event => {
        if (event.event === 'phase') { report.phase = event.phase; save(); }
      } });
    report.status = result.result;
    report.target = result.target;
    if (existsSync(failureFile)) unlinkSync(failureFile);
    return report;
  } catch (error) {
    report.status = error.exitCode === 2 ? 'deferred' : 'failed';
    report.error = error.code ?? 'IO';
    if (error.candidateFailure) {
      report.failure = { version: 1, scope: config.scope, at: new Date().toISOString(), ...error.candidateFailure };
      atomicJson(failureFile, report.failure);
    }
    throw error;
  } finally {
    try {
      if (pauseOwned && readFileSync(spec.guardian.pause_file, 'utf8') === owner) {
        unlinkSync(spec.guardian.pause_file);
        report.guardian_restored = true;
      }
      if (phoneLock && readFileSync(join(phoneLock, 'pid'), 'utf8') === String(process.pid)) {
        // This is exactly the operation directory created above, under the resolved phone state root.
        rmSync(phoneLock, { recursive: true });
      }
    } finally {
      report.finished_at = new Date().toISOString();
      try { save(); } finally { release(); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const args = process.argv.slice(2);
  try {
    if (![2, 3].includes(args.length) || args[0] !== '--config' || (args.length === 3 && args[2] !== '--retry-failed')) {
      throw new DeploymentError('USAGE', 'Use --config <private-auto-deployment.json> [--retry-failed].');
    }
    console.log(JSON.stringify(await autoDeploy(args[1], { signal: controller.signal, retryFailed: args[2] === '--retry-failed' })));
  } catch (error) {
    console.error(JSON.stringify({ error: error.code ?? 'IO', message: error instanceof DeploymentError ? error.message : 'Inspect the private deployment log.' }));
    process.exitCode = error.exitCode ?? 1;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
