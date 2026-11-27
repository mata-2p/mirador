import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idleSleepMs, loadConfig, saveSettings } from '../src/config.ts';

let scratch: string;
let home: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-config-')));
  home = join(scratch, 'home');
  await mkdir(join(home, 'Dev'), { recursive: true });
});

after(() => rm(scratch, { recursive: true, force: true }));

async function configFile(name: string, saved?: unknown): Promise<string> {
  const path = join(scratch, name, 'config.json');
  await mkdir(join(scratch, name), { recursive: true });
  if (saved !== undefined) await writeFile(path, JSON.stringify(saved));
  return path;
}

test('a legacy root becomes one workspace named Dev, and the other saved keys stay', async () => {
  const path = await configFile('legacy', { root: '/srv/projects', port: 5000, agentCommand: 'pi' });
  const config = await loadConfig(path, { HOME: home });
  assert.deepEqual(config.workspaces, [{ id: 'dev', name: 'Dev', root: '/srv/projects', folders: [], expanded: [] }]);
  assert.equal(config.port, 5000);
  assert.equal(config.agentCommand, 'pi');
  assert.equal('root' in config, false);
});

test('S3: a config from the translation days (translateModel, translateBudget) loads without error or problems; nothing reads those keys', async () => {
  const path = await configFile('old-translate', { root: '/srv/projects', translateModel: 'claude-sonnet-5-5', translateBudget: 7, nightBudget: 90 });
  const config = await loadConfig(path, { HOME: home });
  assert.deepEqual(config.workspaces, [{ id: 'dev', name: 'Dev', root: '/srv/projects', folders: [], expanded: [] }]);
  assert.deepEqual([config.workspaceProblems, config.launchProblems], [[], []]);
  assert.equal(config.nightBudget, 90, 'the keys around them still load');
});

test('without a saved file there is one Dev workspace on ~/Dev', async () => {
  const config = await loadConfig(await configFile('none'), { HOME: home });
  assert.deepEqual(config.workspaces, [{ id: 'dev', name: 'Dev', root: join(home, 'Dev'), folders: [], expanded: [] }]);
});

test('saved workspaces win over a leftover root and get empty lists by default', async () => {
  const path = await configFile('saved', {
    root: '/ignored',
    workspaces: [
      { id: 'dev', name: 'Dev', root: '/home/m/Dev', folders: ['web'], expanded: ['web'] },
      { id: 'work', name: 'Work', root: '/home/m/Work' },
    ],
  });
  const config = await loadConfig(path, { HOME: home });
  assert.deepEqual(config.workspaces, [
    { id: 'dev', name: 'Dev', root: '/home/m/Dev', folders: ['web'], expanded: ['web'] },
    { id: 'work', name: 'Work', root: '/home/m/Work', folders: [], expanded: [] },
  ]);
});

test('saving workspaces drops the legacy root and keeps every other saved key', async () => {
  const path = await configFile('save', { root: '/srv/projects', port: 5000 });
  await saveSettings({ workspaces: [{ id: 'dev', name: 'Dev', root: '/srv/projects', folders: [], expanded: [] }] }, path, ['root']);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['port', 'workspaces']);
  assert.equal(saved.port, 5000);
});

const DEV = { id: 'dev', name: 'Dev', root: '/home/m/Dev', folders: [], expanded: [] };

test('a well-formed config has no workspace problems', async () => {
  const path = await configFile('clean', { workspaces: [DEV] });
  assert.deepEqual((await loadConfig(path, { HOME: home })).workspaceProblems, []);
  assert.deepEqual((await loadConfig(await configFile('legacy-clean', { root: '/srv/projects' }), { HOME: home })).workspaceProblems, []);
});

test('workspace entries Mirador cannot read are reported, not silently dropped', async () => {
  const path = await configFile('malformed', { workspaces: [DEV, { name: 'No id', root: '/srv' }, 'oops'] });
  const config = await loadConfig(path, { HOME: home });
  assert.deepEqual(config.workspaces, [DEV], 'the readable ones still show');
  assert.deepEqual(config.workspaceProblems, ['workspaces[1] has no id, name or root', 'workspaces[2] has no id, name or root']);
});

test('a workspaces value that is not a list is reported, and the default shows meanwhile', async () => {
  const path = await configFile('not-a-list', { workspaces: { dev: DEV } });
  const config = await loadConfig(path, { HOME: home });
  assert.deepEqual(config.workspaces, [{ id: 'dev', name: 'Dev', root: join(home, 'Dev'), folders: [], expanded: [] }]);
  assert.deepEqual(config.workspaceProblems, ['workspaces is not a list']);
});

test('duplicate workspace ids are reported and only the first one shows', async () => {
  const path = await configFile('duplicates', { workspaces: [DEV, { ...DEV, name: 'Dev again', root: '/srv/other' }] });
  const config = await loadConfig(path, { HOME: home });
  assert.deepEqual(config.workspaces, [DEV]);
  assert.deepEqual(config.workspaceProblems, ['workspace id "dev" appears more than once']);
});

test('saving through a symlinked config keeps the symlink and writes its target', async () => {
  const target = join(scratch, 'dotfiles', 'mirador.json');
  await mkdir(join(scratch, 'dotfiles'), { recursive: true });
  await writeFile(target, JSON.stringify({ port: 5000 }));
  const path = join(await configFile('linked'), '..', 'config.json');
  await symlink(target, path);

  await saveSettings({ workspaces: [DEV] }, path);
  assert.ok((await lstat(path)).isSymbolicLink(), 'still a symlink');
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { port: 5000, workspaces: [DEV] });
  assert.deepEqual(await readdir(join(scratch, 'dotfiles')), ['mirador.json'], 'no temp file left behind');
});

test('saving keeps the mode of the config file', async () => {
  const path = await configFile('private', { port: 5000 });
  await chmod(path, 0o600);
  await saveSettings({ workspaces: [DEV] }, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).port, 5000);
});

test('launches (R4 batch pacing) keeps the valid keys, drops the invalid ones and reports each, so the defaults apply', async () => {
  const good = await loadConfig(await configFile('launches-good', { launches: { batchSize: 2, settleMs: 0, reserveMb: 4096, maxWaitMs: 60000 } }), { HOME: home });
  assert.deepEqual(good.launches, { batchSize: 2, settleMs: 0, reserveMb: 4096, maxWaitMs: 60000 });
  assert.deepEqual(good.launchProblems, []);

  const bad = await loadConfig(await configFile('launches-bad', { launches: { batchSize: 0, settleMs: 1.5, reserveMb: '2048', maxWaitMs: 3_600_001, other: 1 } }), { HOME: home });
  assert.deepEqual(bad.launches, {});
  assert.deepEqual(bad.launchProblems, [
    'launches.batchSize must be a whole number from 1 to 50; the default applies',
    'launches.settleMs must be a whole number from 0 to 600000; the default applies',
    'launches.reserveMb must be a whole number from 0 to 1048576; the default applies',
    'launches.maxWaitMs must be a whole number from 0 to 3600000; the default applies',
    'launches.other is not a known key; it is ignored',
  ]);

  const notObject = await loadConfig(await configFile('launches-list', { launches: [3] }), { HOME: home });
  assert.deepEqual(notObject.launches, {});
  assert.deepEqual(notObject.launchProblems, ['launches is not an object; the defaults apply']);

  const none = await loadConfig(await configFile('launches-none', { port: 5000 }), { HOME: home });
  assert.deepEqual(none.launches, {});
  assert.deepEqual(none.launchProblems, []);
});

test('idleSleepHours (R5b idle sleep) defaults to 4, takes 0 (off) up to 168, and reports any other value so the default applies', async () => {
  assert.equal((await loadConfig(await configFile('idle-none', { port: 5000 }), { HOME: home })).idleSleepHours, 4);
  assert.equal((await loadConfig(join(scratch, 'idle-missing.json'), { HOME: home })).idleSleepHours, 4, 'no config file');
  for (const hours of [0, 1.5, 168]) {
    const config = await loadConfig(await configFile(`idle-${hours}`, { idleSleepHours: hours }), { HOME: home });
    assert.equal(config.idleSleepHours, hours);
    assert.deepEqual(config.launchProblems, []);
  }
  for (const hours of [-1, 169, '4', true]) {
    const config = await loadConfig(await configFile(`idle-bad-${String(hours)}`, { idleSleepHours: hours }), { HOME: home });
    assert.equal(config.idleSleepHours, 4);
    assert.deepEqual(config.launchProblems, ['idleSleepHours must be a number of hours from 0 (off) to 168; the default (4) applies']);
  }
});

// #115: idle sleep in minutes with a switch; idleSleepHours is still read, and explicit minutes win.
const MIN = 60_000;
test('idle sleep defaults to on and 4 h (240 minutes), with or without a config file', async () => {
  for (const config of [await loadConfig(await configFile('idle-defaults', { port: 5000 }), { HOME: home }), await loadConfig(join(scratch, 'idle-defaults-missing.json'), { HOME: home })]) {
    assert.equal(config.idleSleep, true);
    assert.equal(config.idleSleepMinutes, undefined);
    assert.equal(idleSleepMs(config), 240 * MIN);
    assert.deepEqual(config.launchProblems, []);
  }
});

test('idleSleepMinutes wins over idleSleepHours; idleSleepHours alone is still read; idleSleep false turns idle sleep off', async () => {
  const both = await loadConfig(await configFile('idle-both', { idleSleepHours: 2, idleSleepMinutes: 30 }), { HOME: home });
  assert.deepEqual([both.idleSleepMinutes, both.idleSleepHours, idleSleepMs(both), both.launchProblems], [30, 2, 30 * MIN, []]);
  const minutesWinOverOff = await loadConfig(await configFile('idle-minutes-hours-0', { idleSleepHours: 0, idleSleepMinutes: 45 }), { HOME: home });
  assert.equal(idleSleepMs(minutesWinOverOff), 45 * MIN, 'explicit minutes win over idleSleepHours 0');
  const hours = await loadConfig(await configFile('idle-hours', { idleSleepHours: 1.5 }), { HOME: home });
  assert.equal(idleSleepMs(hours), 90 * MIN);
  for (const minutes of [1, 10080]) {
    const config = await loadConfig(await configFile(`idle-minutes-${minutes}`, { idleSleepMinutes: minutes }), { HOME: home });
    assert.deepEqual([config.idleSleepMinutes, idleSleepMs(config), config.launchProblems], [minutes, minutes * MIN, []]);
  }
  const off = await loadConfig(await configFile('idle-off', { idleSleep: false, idleSleepMinutes: 30 }), { HOME: home });
  assert.deepEqual([off.idleSleep, off.idleSleepMinutes, idleSleepMs(off), off.launchProblems], [false, 30, 0, []]);
  const on = await loadConfig(await configFile('idle-on', { idleSleep: true }), { HOME: home });
  assert.deepEqual([on.idleSleep, idleSleepMs(on)], [true, 240 * MIN]);
});

test('PRESERVE: idleSleepHours 0 still turns idle sleep off when no minutes are set', async () => {
  const config = await loadConfig(await configFile('idle-hours-0', { idleSleepHours: 0 }), { HOME: home });
  assert.deepEqual([config.idleSleep, config.idleSleepHours, idleSleepMs(config), config.launchProblems], [true, 0, 0, []]);
});

test('bad idleSleep and idleSleepMinutes values are reported, one line each, and the defaults apply', async () => {
  for (const minutes of [0, 10081, 1.5, '30', -5, true]) {
    const config = await loadConfig(await configFile(`idle-bad-minutes-${String(minutes)}`, { idleSleepMinutes: minutes, idleSleepHours: 2 }), { HOME: home });
    assert.equal(config.idleSleepMinutes, undefined, String(minutes));
    assert.equal(idleSleepMs(config), 2 * 60 * MIN, `${String(minutes)}: idleSleepHours applies`);
    assert.deepEqual(config.launchProblems, ['idleSleepMinutes must be a whole number of minutes from 1 to 10080; idleSleepHours or the default (240) applies']);
  }
  const noHours = await loadConfig(await configFile('idle-bad-minutes-no-hours', { idleSleepMinutes: 0 }), { HOME: home });
  assert.equal(idleSleepMs(noHours), 240 * MIN, 'the default without idleSleepHours');
  for (const value of ['off', 0, 'false', {}]) {
    const config = await loadConfig(await configFile(`idle-bad-switch-${JSON.stringify(value)}`, { idleSleep: value }), { HOME: home });
    assert.equal(config.idleSleep, true, JSON.stringify(value));
    assert.equal(idleSleepMs(config), 240 * MIN);
    assert.deepEqual(config.launchProblems, ['idleSleep must be true or false; the default (on) applies']);
  }
  const nulls = await loadConfig(await configFile('idle-nulls', { idleSleep: null, idleSleepMinutes: null }), { HOME: home });
  assert.deepEqual([nulls.idleSleep, nulls.idleSleepMinutes, nulls.launchProblems], [true, undefined, []], 'null is the same as absent');
});

test('a saved shell that is not bash is reported but kept, so plain terminals still use it (#10)', async () => {
  const zsh = await loadConfig(await configFile('shell-zsh', { shell: '/bin/zsh' }), { HOME: home });
  assert.equal(zsh.shell, '/bin/zsh', 'the value is not replaced');
  assert.deepEqual(zsh.launchProblems, [
    'shell is not bash, so agent terminals cannot start (they run `bash --rcfile`); other terminals are unaffected',
  ]);

  for (const shell of ['/bin/bash', '/usr/local/bin/bash', 'bash', 'C:\\Program Files\\Git\\bin\\bash.exe']) {
    const ok = await loadConfig(await configFile(`shell-ok-${shell.replace(/\W+/g, '-')}`, { shell }), { HOME: home });
    assert.equal(ok.shell, shell);
    assert.deepEqual(ok.launchProblems, [], shell);
  }

  const none = await loadConfig(await configFile('shell-none', { port: 5000 }), { HOME: home });
  assert.deepEqual(none.launchProblems, []);
});
