'use strict';
// JS-layer tests for www/Flashlight.js. Run with `npm test` (Node 18+, no dependencies).
// The Cordova bridge is replaced by a fake `exec` that records calls and lets each test
// answer them with success or error, as native would.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'www', 'Flashlight.js'), 'utf8');

function load() {
  const calls = [];
  const exec = (success, error, service, action, args) => {
    calls.push({ success, error, service, action, args });
  };
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
    cordova: { addConstructor: (fn) => constructors.push(fn) },
    console: { error() {}, warn() {} },
    setTimeout,
    Promise,
  };
  vm.runInNewContext(SOURCE, sandbox);
  constructors.forEach((fn) => fn());
  const last = (action) => {
    const matching = calls.filter((c) => c.action === action);
    return matching[matching.length - 1];
  };
  return { fl: sandbox.window.plugins.flashlight, exported: module.exports, calls, last };
}

const tick = () => new Promise((r) => setImmediate(r));

test('installs one instance at window.plugins.flashlight and exports the same object', () => {
  const { fl, exported } = load();
  assert.ok(fl);
  assert.equal(fl, exported);
});

// ------------------------------------------------------------ callback style (wrapper contract)

test('callback style: switchOn(success, error) returns undefined and passes [opts] to native', () => {
  const { fl, calls } = load();
  const ret = fl.switchOn(() => {}, () => {});
  assert.equal(ret, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, 'Flashlight');
  assert.equal(calls[0].action, 'switchOn');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), [{}]);
});

test('callback style: options still go in the third position', () => {
  const { fl, last } = load();
  fl.switchOn(() => {}, () => {}, { intensity: 0.3 });
  assert.deepEqual(JSON.parse(JSON.stringify(last('switchOn').args)), [{ intensity: 0.3 }]);
});

test('isSwitchedOn flips only on native success, and is already true inside the success callback', () => {
  const { fl, last } = load();
  let seenInCallback = null;
  fl.switchOn(() => { seenInCallback = fl.isSwitchedOn(); }, () => {});
  assert.equal(fl.isSwitchedOn(), false, 'must not flip before native answers');
  last('switchOn').success();
  assert.equal(seenInCallback, true);
  assert.equal(fl.isSwitchedOn(), true);
});

test('a failed switchOn leaves isSwitchedOn false', () => {
  const { fl, last } = load();
  let err = null;
  fl.switchOn(() => {}, (e) => { err = e; });
  last('switchOn').error('camera in use');
  assert.equal(err, 'camera in use');
  assert.equal(fl.isSwitchedOn(), false);
});

test('a failed switchOff leaves isSwitchedOn true', () => {
  const { fl, last } = load();
  fl.switchOn(() => {}, () => {});
  last('switchOn').success();
  fl.switchOff(() => {}, () => {});
  last('switchOff').error('boom');
  assert.equal(fl.isSwitchedOn(), true);
});

test('toggle picks switchOn/switchOff from the confirmed state', () => {
  const { fl, last, calls } = load();
  fl.toggle(() => {}, () => {});
  assert.equal(calls[calls.length - 1].action, 'switchOn');
  last('switchOn').success();
  fl.toggle(() => {}, () => {});
  assert.equal(calls[calls.length - 1].action, 'switchOff');
});

test('available(callback) maps native 1/0 to booleans and errors to false', () => {
  const { fl, calls } = load();
  const results = [];
  fl.available((v) => results.push(v));
  fl.available((v) => results.push(v));
  fl.available((v) => results.push(v));
  calls[0].success(1);
  calls[1].success(0);
  calls[2].error('x');
  assert.deepEqual(results, [true, false, false]);
});

// ------------------------------------------------------------ promise style

test('promise style: switchOn() resolves after native success and updates state first', async () => {
  const { fl, last } = load();
  const p = fl.switchOn();
  assert.ok(p && typeof p.then === 'function');
  last('switchOn').success();
  await p;
  assert.equal(fl.isSwitchedOn(), true);
});

test('promise style: switchOn(options) sends the options', async () => {
  const { fl, last } = load();
  const p = fl.switchOn({ intensity: 0.5 });
  assert.deepEqual(JSON.parse(JSON.stringify(last('switchOn').args)), [{ intensity: 0.5 }]);
  last('switchOn').success();
  await p;
});

test('promise style: switchOn() rejects with the native error and keeps state', async () => {
  const { fl, last } = load();
  const p = fl.switchOn();
  last('switchOn').error('nope');
  await assert.rejects(p, (e) => e === 'nope');
  assert.equal(fl.isSwitchedOn(), false);
});

test('promise style: switchOff() and toggle()', async () => {
  const { fl, last } = load();
  let p = fl.toggle();
  last('switchOn').success();
  await p;
  assert.equal(fl.isSwitchedOn(), true);
  p = fl.toggle();
  last('switchOff').success();
  await p;
  assert.equal(fl.isSwitchedOn(), false);
});

test('promise style: available() resolves booleans and never rejects', async () => {
  const { fl, calls } = load();
  const a = fl.available();
  const b = fl.available();
  calls[0].success(true);
  calls[1].error('x');
  assert.equal(await a, true);
  assert.equal(await b, false);
});

// ------------------------------------------------------------ strength

test('getMaxStrengthLevel / getStrengthLevel resolve the native integers', async () => {
  const { fl, last } = load();
  const max = fl.getMaxStrengthLevel();
  last('getMaxStrengthLevel').success(5);
  assert.equal(await max, 5);
  const lvl = fl.getStrengthLevel();
  last('getStrengthLevel').success(3);
  assert.equal(await lvl, 3);
});

test('switchOnWithStrength sends an integer level and sets state on success', async () => {
  const { fl, last } = load();
  const p = fl.switchOnWithStrength('4');
  assert.deepEqual(Array.from(last('switchOnWithStrength').args), [4]);
  assert.equal(fl.isSwitchedOn(), false);
  last('switchOnWithStrength').success(4);
  assert.equal(await p, 4);
  assert.equal(fl.isSwitchedOn(), true);
});

test('switchOnWithStrength callback style', () => {
  const { fl, last } = load();
  let got = null;
  const ret = fl.switchOnWithStrength(2, (l) => { got = l; }, () => {});
  assert.equal(ret, undefined);
  last('switchOnWithStrength').success(2);
  assert.equal(got, 2);
});

// ------------------------------------------------------------ state listener

test('onStateChange registers ONE native listener for many JS listeners', () => {
  const { fl, calls } = load();
  fl.onStateChange(() => {});
  fl.onStateChange(() => {});
  assert.equal(calls.filter((c) => c.action === 'startStateListener').length, 1);
});

test('state events reach every listener and sync isSwitchedOn (e.g. Quick Settings tile)', () => {
  const { fl, last } = load();
  const a = [];
  const b = [];
  fl.onStateChange((s) => a.push(s.isOn));
  fl.onStateChange((s) => b.push(s.isOn));
  const native = last('startStateListener');
  native.success({ isOn: true, available: true, strengthLevel: 1, maxStrengthLevel: 1 });
  assert.equal(fl.isSwitchedOn(), true);
  native.success({ isOn: false, available: true, strengthLevel: 0, maxStrengthLevel: 1 });
  assert.equal(fl.isSwitchedOn(), false);
  assert.deepEqual(a, [true, false]);
  assert.deepEqual(b, [true, false]);
});

test('a throwing listener does not starve the others', () => {
  const { fl, last } = load();
  const seen = [];
  fl.onStateChange(() => { throw new Error('bad'); });
  fl.onStateChange((s) => seen.push(s.isOn));
  last('startStateListener').success({ isOn: true, available: true, strengthLevel: 1, maxStrengthLevel: 1 });
  assert.deepEqual(seen, [true]);
});

test('a late subscriber gets the last known state', async () => {
  const { fl, last } = load();
  fl.onStateChange(() => {});
  last('startStateListener').success({ isOn: true, available: true, strengthLevel: 2, maxStrengthLevel: 5 });
  const late = [];
  fl.onStateChange((s) => late.push(s.strengthLevel));
  await tick();
  assert.deepEqual(late, [2]);
});

test('offStateChange stops native only when the last listener leaves', () => {
  const { fl, calls } = load();
  const a = fl.onStateChange(() => {});
  const b = fl.onStateChange(() => {});
  fl.offStateChange(a);
  assert.equal(calls.filter((c) => c.action === 'stopStateListener').length, 0);
  fl.offStateChange(b);
  assert.equal(calls.filter((c) => c.action === 'stopStateListener').length, 1);
});

test('offStateChange() with no argument removes all listeners', () => {
  const { fl, calls } = load();
  fl.onStateChange(() => {});
  fl.onStateChange(() => {});
  fl.offStateChange();
  assert.equal(calls.filter((c) => c.action === 'stopStateListener').length, 1);
});

test('events after offStateChange and the NO_RESULT release are ignored', () => {
  const { fl, last } = load();
  const seen = [];
  const cb = fl.onStateChange((s) => seen.push(s));
  const native = last('startStateListener');
  fl.offStateChange(cb);
  native.success(undefined); // NO_RESULT release
  native.success({ isOn: true, available: true, strengthLevel: 1, maxStrengthLevel: 1 });
  assert.equal(seen.length, 0);
  assert.equal(fl.isSwitchedOn(), false);
});

test('re-subscribing after off starts a fresh native listener', () => {
  const { fl, calls } = load();
  const cb = fl.onStateChange(() => {});
  fl.offStateChange(cb);
  fl.onStateChange(() => {});
  assert.equal(calls.filter((c) => c.action === 'startStateListener').length, 2);
});

test('onStateChange rejects a non-function', () => {
  const { fl } = load();
  assert.throws(() => fl.onStateChange('nope'), (e) => e.name === 'TypeError');
});
