'use strict';
// Tests for hooks/android-manifest.js: the opt-in manifest entries.
// Off (the default) must leave the manifest byte-for-byte unchanged; on must add exactly the
// expected nodes; runs must be idempotent; toggling off must remove only what the hook added.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const hook = require('../hooks/android-manifest.js');
const { applyManifest, resolveFlags } = hook;

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'AndroidManifest.xml'), 'utf8');
const PLUGIN_ID = 'community-cordova-plugin-flashlight';
const FGS_PERMS = hook.FGS_PERMISSIONS;

const count = (xml, re) => (xml.match(re) || []).length;
const perm = (xml, name) => count(xml, new RegExp(`<uses-permission android:name="${name.replace(/\./g, '\\.')}"`, 'g'));
const service = (xml, cls) => count(xml, new RegExp(`<service\\b[^>]*android:name="nl\\.xservices\\.plugins\\.${cls}"`, 'g'));

function serviceBlock(xml, cls) {
  const m = new RegExp(`<service\\b[^>]*android:name="nl\\.xservices\\.plugins\\.${cls}"[\\s\\S]*?</service>`).exec(xml);
  return m && m[0];
}

function xmllintOk(xml) {
  const f = path.join(os.tmpdir(), `flashlight-manifest-${process.pid}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(f, xml);
  try {
    execFileSync('xmllint', ['--noout', f], { stdio: 'pipe' });
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return true; // no xmllint on this machine: well-formedness not checked
    throw new Error('not well-formed XML: ' + e.stderr);
  } finally {
    fs.unlinkSync(f);
  }
}

// ------------------------------------------------------------ flags

test('flags: everything defaults to off', () => {
  assert.deepEqual(resolveFlags({}), { qsTile: false, torchService: false, sosTile: false, sosIgnored: false });
  assert.deepEqual(resolveFlags(undefined), { qsTile: false, torchService: false, sosTile: false, sosIgnored: false });
  assert.equal(resolveFlags({ ENABLE_QS_TILE: 'false', ENABLE_TORCH_SERVICE: 'no' }).qsTile, false);
});

test('flags: "true" in any case (and 1 / yes) turns a variable on', () => {
  assert.equal(resolveFlags({ ENABLE_QS_TILE: 'TRUE' }).qsTile, true);
  assert.equal(resolveFlags({ ENABLE_QS_TILE: '1' }).qsTile, true);
  assert.equal(resolveFlags({ ENABLE_TORCH_SERVICE: true }).torchService, true);
});

test('flags: the SOS tile needs the torch service', () => {
  const f = resolveFlags({ ENABLE_SOS_TILE: 'true' });
  assert.equal(f.sosTile, false);
  assert.equal(f.sosIgnored, true);
  assert.equal(resolveFlags({ ENABLE_SOS_TILE: 'true', ENABLE_TORCH_SERVICE: 'true' }).sosTile, true);
});

// ------------------------------------------------------------ off = nothing

test('variables off: the manifest is unchanged, byte for byte', () => {
  const r = applyManifest(SAMPLE, resolveFlags({}), { addedPermissions: [] });
  assert.equal(r.xml, SAMPLE);
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.state.addedPermissions, []);
});

test('ENABLE_SOS_TILE alone adds nothing', () => {
  const r = applyManifest(SAMPLE, resolveFlags({ ENABLE_SOS_TILE: 'true' }), {});
  assert.equal(r.xml, SAMPLE);
});

// ------------------------------------------------------------ on = the expected nodes

test('ENABLE_QS_TILE: adds the tile service and no permission', () => {
  const r = applyManifest(SAMPLE, resolveFlags({ ENABLE_QS_TILE: 'true' }), {});
  assert.equal(service(r.xml, 'TorchTileService'), 1);
  assert.equal(service(r.xml, 'TorchForegroundService'), 0);
  assert.equal(service(r.xml, 'SosTileService'), 0);
  for (const p of FGS_PERMS) assert.equal(perm(r.xml, p), 0, p);
  const block = serviceBlock(r.xml, 'TorchTileService');
  assert.match(block, /android:exported="true"/);
  assert.match(block, /android:permission="android\.permission\.BIND_QUICK_SETTINGS_TILE"/);
  assert.match(block, /android:label="@string\/flashlight_tile_label"/);
  assert.match(block, /android:icon="@drawable\/flashlight_ic_torch"/);
  assert.match(block, /<action android:name="android\.service\.quicksettings\.action\.QS_TILE" \/>/);
  assert.match(block, /<meta-data android:name="android\.service\.quicksettings\.TOGGLEABLE_TILE" android:value="true" \/>/);
  // inside <application>
  assert.ok(r.xml.indexOf('TorchTileService') < r.xml.indexOf('</application>'));
  assert.ok(r.xml.indexOf('TorchTileService') > r.xml.indexOf('<application'));
  assert.ok(xmllintOk(r.xml));
});

test('ENABLE_TORCH_SERVICE: adds the specialUse FGS with its subtype property and the three permissions', () => {
  const r = applyManifest(SAMPLE, resolveFlags({ ENABLE_TORCH_SERVICE: 'true' }), {});
  assert.equal(service(r.xml, 'TorchForegroundService'), 1);
  assert.equal(service(r.xml, 'TorchTileService'), 0);
  const block = serviceBlock(r.xml, 'TorchForegroundService');
  assert.match(block, /android:exported="false"/);
  assert.match(block, /android:foregroundServiceType="specialUse"/);
  assert.match(block, /<property android:name="android\.app\.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="torch_control" \/>/);
  for (const p of FGS_PERMS) assert.equal(perm(r.xml, p), 1, p);
  // permissions go before <application>, next to the existing ones
  assert.ok(r.xml.indexOf('FOREGROUND_SERVICE_SPECIAL_USE') < r.xml.indexOf('<application'));
  assert.deepEqual(r.state.addedPermissions, [...FGS_PERMS].sort());
  assert.ok(xmllintOk(r.xml));
});

test('all three on: tile, SOS tile and service, each once', () => {
  const r = applyManifest(SAMPLE, resolveFlags({ ENABLE_QS_TILE: 'true', ENABLE_SOS_TILE: 'true', ENABLE_TORCH_SERVICE: 'true' }), {});
  assert.equal(service(r.xml, 'TorchTileService'), 1);
  assert.equal(service(r.xml, 'SosTileService'), 1);
  assert.equal(service(r.xml, 'TorchForegroundService'), 1);
  const sos = serviceBlock(r.xml, 'SosTileService');
  assert.match(sos, /android:label="@string\/flashlight_sos_tile_label"/);
  assert.match(sos, /android:icon="@drawable\/flashlight_ic_sos"/);
  assert.match(sos, /BIND_QUICK_SETTINGS_TILE/);
  // nothing else of the original was lost
  assert.match(r.xml, /android\.permission\.INTERNET/);
  assert.match(r.xml, /android\.intent\.category\.LAUNCHER/);
  assert.ok(xmllintOk(r.xml));
});

// ------------------------------------------------------------ idempotency / toggling

test('idempotent: a second run changes nothing', () => {
  const flags = resolveFlags({ ENABLE_QS_TILE: 'true', ENABLE_SOS_TILE: 'true', ENABLE_TORCH_SERVICE: 'true' });
  const a = applyManifest(SAMPLE, flags, {});
  const b = applyManifest(a.xml, flags, a.state);
  assert.equal(b.xml, a.xml);
  assert.deepEqual(b.changes, []);
});

test('idempotent after cordova-android re-serialises the manifest (re-indent, " />" -> "/>")', () => {
  const flags = resolveFlags({ ENABLE_QS_TILE: 'true', ENABLE_TORCH_SERVICE: 'true' });
  const a = applyManifest(SAMPLE, flags, {});
  const reformatted = a.xml.replace(/ \/>/g, '/>').replace(/\n {8}/g, '\n\t\t');
  const b = applyManifest(reformatted, flags, a.state);
  assert.equal(b.xml, reformatted);
  assert.deepEqual(b.changes, []);
});

test('an outdated service definition from an older plugin version is replaced', () => {
  const flags = resolveFlags({ ENABLE_TORCH_SERVICE: 'true' });
  const a = applyManifest(SAMPLE, flags, {});
  const old = a.xml.replace('android:value="torch_control"', 'android:value="old"');
  const b = applyManifest(old, flags, a.state);
  assert.equal(service(b.xml, 'TorchForegroundService'), 1);
  assert.match(b.xml, /torch_control/);
  assert.doesNotMatch(b.xml, /"old"/);
  assert.deepEqual(b.changes, ['updated service nl.xservices.plugins.TorchForegroundService']);
});

test('switching everything off again restores the original manifest', () => {
  const on = applyManifest(SAMPLE, resolveFlags({ ENABLE_QS_TILE: 'true', ENABLE_SOS_TILE: 'true', ENABLE_TORCH_SERVICE: 'true' }), {});
  const off = applyManifest(on.xml, resolveFlags({}), on.state);
  assert.equal(off.xml, SAMPLE);
  assert.deepEqual(off.state.addedPermissions, []);
});

test('switching one variable off removes only its entries', () => {
  const on = applyManifest(SAMPLE, resolveFlags({ ENABLE_QS_TILE: 'true', ENABLE_TORCH_SERVICE: 'true' }), {});
  const r = applyManifest(on.xml, resolveFlags({ ENABLE_QS_TILE: 'true' }), on.state);
  assert.equal(service(r.xml, 'TorchTileService'), 1);
  assert.equal(service(r.xml, 'TorchForegroundService'), 0);
  for (const p of FGS_PERMS) assert.equal(perm(r.xml, p), 0, p);
});

test('a permission the app (or another plugin) already declares is not duplicated and never removed', () => {
  const withPerm = SAMPLE.replace(
    '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'
  );
  const on = applyManifest(withPerm, resolveFlags({ ENABLE_TORCH_SERVICE: 'true' }), {});
  assert.equal(perm(on.xml, 'android.permission.POST_NOTIFICATIONS'), 1);
  assert.ok(!on.state.addedPermissions.includes('android.permission.POST_NOTIFICATIONS'));
  const off = applyManifest(on.xml, resolveFlags({}), on.state);
  assert.equal(perm(off.xml, 'android.permission.POST_NOTIFICATIONS'), 1, 'someone else\'s permission must stay');
  assert.equal(off.xml, withPerm);
});

test('a manifest without </application> is an error when something must be added, fine when not', () => {
  const broken = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"></manifest>';
  assert.throws(() => applyManifest(broken, resolveFlags({ ENABLE_QS_TILE: 'true' }), {}), /application/);
  assert.equal(applyManifest(broken, resolveFlags({}), {}).xml, broken);
});

// ------------------------------------------------------------ the Cordova entry point, on disk

function project({ pkgVars, platformVars, configVars } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flashlight-hook-'));
  const main = path.join(root, 'platforms', 'android', 'app', 'src', 'main');
  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(path.join(main, 'AndroidManifest.xml'), SAMPLE);
  const plugins = {};
  if (pkgVars) plugins[PLUGIN_ID] = pkgVars;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', cordova: { plugins, platforms: ['android'] } }));
  if (platformVars) {
    fs.writeFileSync(path.join(root, 'platforms', 'android', 'android.json'),
      JSON.stringify({ installed_plugins: { [PLUGIN_ID]: platformVars }, dependent_plugins: {} }));
  }
  const vars = Object.entries(configVars || {}).map(([k, v]) => `<variable name="${k}" value="${v}" />`).join('');
  fs.writeFileSync(path.join(root, 'config.xml'),
    `<?xml version="1.0"?><widget id="x"><plugin name="${PLUGIN_ID}" spec="^3.5.0">${vars}</plugin></widget>`);
  return {
    root,
    manifest: () => fs.readFileSync(path.join(main, 'AndroidManifest.xml'), 'utf8'),
    mtime: () => fs.statSync(path.join(main, 'AndroidManifest.xml')).mtimeMs,
    state: path.join(root, 'platforms', 'android', hook.STATE_FILE),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runHook(p, hookName, extra) {
  const log = console.log;
  const warn = console.warn;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    hook(Object.assign({ hook: hookName, opts: { projectRoot: p.root, platforms: ['android'] } }, extra));
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

test('hook: plugin installed without variables -> after_prepare leaves the manifest untouched, no state file', () => {
  const p = project({ pkgVars: {}, platformVars: {} });
  try {
    const lines = runHook(p, 'after_prepare');
    assert.equal(p.manifest(), SAMPLE);
    assert.equal(fs.existsSync(p.state), false);
    assert.deepEqual(lines, []);
  } finally {
    p.cleanup();
  }
});

test('hook: variables from platforms/android/android.json are applied, and a rerun is a no-op', () => {
  const p = project({ platformVars: { ENABLE_QS_TILE: 'true', ENABLE_TORCH_SERVICE: 'true' } });
  try {
    runHook(p, 'after_prepare');
    const once = p.manifest();
    assert.equal(service(once, 'TorchTileService'), 1);
    assert.equal(service(once, 'TorchForegroundService'), 1);
    assert.ok(fs.existsSync(p.state));
    const lines = runHook(p, 'after_prepare');
    assert.equal(p.manifest(), once);
    assert.deepEqual(lines, []);
  } finally {
    p.cleanup();
  }
});

test('hook: package.json cordova.plugins variables are used when android.json has none', () => {
  const p = project({ pkgVars: { ENABLE_QS_TILE: 'true' } });
  try {
    runHook(p, 'after_prepare');
    assert.equal(service(p.manifest(), 'TorchTileService'), 1);
  } finally {
    p.cleanup();
  }
});

test('hook: android.json wins over package.json, which wins over config.xml', () => {
  const p = project({
    configVars: { ENABLE_QS_TILE: 'true', ENABLE_TORCH_SERVICE: 'true' },
    pkgVars: { ENABLE_TORCH_SERVICE: 'false' },
    platformVars: { ENABLE_QS_TILE: 'false' },
  });
  try {
    runHook(p, 'after_prepare');
    assert.equal(p.manifest(), SAMPLE);
  } finally {
    p.cleanup();
  }
});

test('hook: config.xml <variable> alone is honoured', () => {
  const p = project({ configVars: { ENABLE_TORCH_SERVICE: 'true' } });
  try {
    runHook(p, 'after_prepare');
    assert.equal(service(p.manifest(), 'TorchForegroundService'), 1);
  } finally {
    p.cleanup();
  }
});

test('hook: after_plugin_install uses the --variable values of the running command', () => {
  const p = project({});
  try {
    runHook(p, 'after_plugin_install', { opts: { projectRoot: p.root, platforms: ['android'], cli_variables: { ENABLE_QS_TILE: 'true' } } });
    assert.equal(service(p.manifest(), 'TorchTileService'), 1);
  } finally {
    p.cleanup();
  }
});

test('hook: before_plugin_uninstall removes everything it added and its state file', () => {
  const p = project({ platformVars: { ENABLE_QS_TILE: 'true', ENABLE_SOS_TILE: 'true', ENABLE_TORCH_SERVICE: 'true' } });
  try {
    runHook(p, 'after_prepare');
    assert.notEqual(p.manifest(), SAMPLE);
    runHook(p, 'before_plugin_uninstall');
    assert.equal(p.manifest(), SAMPLE);
    assert.equal(fs.existsSync(p.state), false);
  } finally {
    p.cleanup();
  }
});

test('hook: ENABLE_SOS_TILE without the service warns and adds nothing', () => {
  const p = project({ platformVars: { ENABLE_SOS_TILE: 'true' } });
  try {
    const lines = runHook(p, 'after_prepare');
    assert.equal(p.manifest(), SAMPLE);
    assert.ok(lines.some((l) => /ENABLE_SOS_TILE needs ENABLE_TORCH_SERVICE/.test(l)));
  } finally {
    p.cleanup();
  }
});

test('hook: an iOS-only prepare and a project without the android platform are left alone', () => {
  const p = project({ platformVars: { ENABLE_QS_TILE: 'true' } });
  try {
    runHook(p, 'after_prepare', { opts: { projectRoot: p.root, platforms: ['ios'] } });
    assert.equal(p.manifest(), SAMPLE);
  } finally {
    p.cleanup();
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'flashlight-hook-empty-'));
  try {
    hook({ hook: 'after_prepare', opts: { projectRoot: empty, platforms: ['android'] } });
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('plugin.xml declares the three variables defaulting to false and registers the hook', () => {
  const xml = fs.readFileSync(path.join(__dirname, '..', 'plugin.xml'), 'utf8');
  for (const v of ['ENABLE_QS_TILE', 'ENABLE_SOS_TILE', 'ENABLE_TORCH_SERVICE']) {
    assert.match(xml, new RegExp(`<preference name="${v}" default="false"/>`));
  }
  for (const h of ['after_prepare', 'after_plugin_install', 'before_plugin_uninstall']) {
    assert.match(xml, new RegExp(`<hook type="${h}" src="hooks/android-manifest.js"/>`));
  }
  // no <config-file> may touch AndroidManifest.xml: that would bypass the opt-in
  assert.doesNotMatch(xml, /target="AndroidManifest\.xml"/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(xml, new RegExp(`id="${PLUGIN_ID}"\\s+version="${pkg.version.replace(/\./g, '\\.')}"`));
  assert.ok(pkg.files.includes('hooks/'), 'hooks/ must ship in the npm package');
});
