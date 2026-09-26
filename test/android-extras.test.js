'use strict';
// JS-layer tests for the 3.5.0 Android extras: startPattern / stopPattern / setOngoingNotification /
// requestAddTile / getFeatures and switchOn({autoOffSeconds}). Same fake-exec approach as
// flashlight.test.js, with cordova.platformId set per test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'www', 'Flashlight.js'), 'utf8');

function load(platformId) {
  const calls = [];
  const exec = (success, error, service, action, args) => calls.push({ success, error, service, action, args });
  const constructors = [];
  const module = { exports: {} };
  const sandbox = {
    require: (id) => {
      if (id === 'cordova/exec') return exec;
      throw new Error('unexpected require ' + id);
    },
    module,
    exports: module.exports,
    window: {},
    cordova: { platformId, addConstructor: (fn) => constructors.push(fn) },
    console: { error() {}, warn() {} },
    setTimeout,
    Promise,
  };
  vm.runInNewContext(SOURCE, sandbox);
  constructors.forEach((fn) => fn());
  const last = (action) => calls.filter((c) => c.action === action).pop();
  return { fl: sandbox.window.plugins.flashlight, calls, last };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test('android: startPattern(options) sends the options and resolves with native\'s answer', async () => {
  const { fl, last } = load('android');
  const p = fl.startPattern({ type: 'strobe', hz: 12 });
  const c = last('startPattern');
  assert.equal(c.service, 'Flashlight');
  assert.deepEqual(plain(c.args), [{ type: 'strobe', hz: 12 }]);
  c.success({ type: 'strobe', hz: 12 });
  assert.deepEqual(plain(await p), { type: 'strobe', hz: 12 });
});

test('android: startPattern() with no options sends {} (native defaults to sos)', () => {
  const { fl, last } = load('android');
  fl.startPattern().catch(() => {});
  assert.deepEqual(plain(last('startPattern').args), [{}]);
});

test('android: startPattern callback style returns undefined and reports the native error', () => {
  const { fl, last } = load('android');
  let err = null;
  const ret = fl.startPattern({ type: 'sos' }, () => {}, (e) => { err = e; });
  assert.equal(ret, undefined);
  last('startPattern').error('startPattern requires the plugin variable ENABLE_TORCH_SERVICE=true');
  assert.match(err, /ENABLE_TORCH_SERVICE/);
});

test('android: startPattern does not change isSwitchedOn (a pattern is not "on")', async () => {
  const { fl, last } = load('android');
  const p = fl.startPattern({ type: 'sos' });
  last('startPattern').success({ type: 'sos' });
  await p;
  assert.equal(fl.isSwitchedOn(), false);
});

test('android: stopPattern / getFeatures / requestAddTile / setOngoingNotification reach native', async () => {
  const { fl, last } = load('android');
  const s = fl.stopPattern();
  last('stopPattern').success();
  await s;

  const f = fl.getFeatures();
  last('getFeatures').success({ qsTile: true, sosTile: false, torchService: true, ongoingNotification: true, canRequestAddTile: true, runningPattern: null });
  assert.equal((await f).qsTile, true);

  const t = fl.requestAddTile();
  assert.deepEqual(plain(last('requestAddTile').args), [{}]);
  last('requestAddTile').success(2);
  assert.equal(await t, fl.TILE_ADD_RESULT.ADDED);

  const n = fl.setOngoingNotification({ enabled: true, title: 'Taschenlampe an', offLabel: 'Ausschalten' });
  assert.deepEqual(plain(last('setOngoingNotification').args), [{ enabled: true, title: 'Taschenlampe an', offLabel: 'Ausschalten' }]);
  last('setOngoingNotification').success({ enabled: true, permission: 'granted' });
  assert.deepEqual(plain(await n), { enabled: true, permission: 'granted' });
});

test('android: setOngoingNotification({paused}) passes only the pause flag to native', async () => {
  const { fl, last } = load('android');
  const p = fl.setOngoingNotification({ paused: true });
  assert.deepEqual(plain(last('setOngoingNotification').args), [{ paused: true }]);
  last('setOngoingNotification').success({ enabled: true, paused: true, permission: 'denied' });
  assert.deepEqual(plain(await p), { enabled: true, paused: true, permission: 'denied' });
});

test('android: requestAddTile({tile: "sos"}) and the callback-first form', () => {
  const { fl, last, calls } = load('android');
  fl.requestAddTile({ tile: 'sos' }).catch(() => {});
  assert.deepEqual(plain(last('requestAddTile').args), [{ tile: 'sos' }]);
  let code = null;
  const ret = fl.requestAddTile((c) => { code = c; }, () => {});
  assert.equal(ret, undefined);
  assert.deepEqual(plain(calls[calls.length - 1].args), [{}]);
  calls[calls.length - 1].success(1);
  assert.equal(code, 1);
});

test('android: switchOn({autoOffSeconds}) passes it through unchanged, in both styles', () => {
  const { fl, last } = load('android');
  fl.switchOn({ autoOffSeconds: 300 }).catch(() => {});
  assert.deepEqual(plain(last('switchOn').args), [{ autoOffSeconds: 300 }]);
  fl.switchOn(() => {}, () => {}, { autoOffSeconds: 60, intensity: 0.5 });
  assert.deepEqual(plain(last('switchOn').args), [{ autoOffSeconds: 60, intensity: 0.5 }]);
});

test('ios: the Android-only calls reject without calling native', async () => {
  const { fl, calls } = load('ios');
  await assert.rejects(fl.startPattern({ type: 'sos' }), /Android only/);
  await assert.rejects(fl.stopPattern(), /Android only/);
  await assert.rejects(fl.setOngoingNotification({ enabled: true }), /Android only/);
  await assert.rejects(fl.requestAddTile(), /Android only/);
  assert.equal(calls.length, 0);
});

test('ios: callback style gets the error asynchronously and returns undefined', async () => {
  const { fl } = load('ios');
  let err = null;
  const ret = fl.stopPattern(() => {}, (e) => { err = e; });
  assert.equal(ret, undefined);
  assert.equal(err, null, 'must not call back synchronously');
  await new Promise((r) => setTimeout(r, 0));
  assert.match(err, /not supported on ios/);
});

test('ios: getFeatures resolves with everything off, fresh object each time', async () => {
  const { fl, calls } = load('ios');
  const a = await fl.getFeatures();
  assert.deepEqual(plain(a), { qsTile: false, sosTile: false, torchService: false, ongoingNotification: false, canRequestAddTile: false, runningPattern: null });
  a.qsTile = true;
  assert.equal((await fl.getFeatures()).qsTile, false);
  let viaCb = null;
  fl.getFeatures((f) => { viaCb = f; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(viaCb.torchService, false);
  assert.equal(calls.length, 0);
});
