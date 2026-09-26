'use strict';
/**
 * Opt-in Android manifest entries for community-cordova-plugin-flashlight.
 *
 * Cordova can't make a <config-file> depend on a plugin variable, and manifest placeholders can
 * only disable a component - they can't remove a <uses-permission>. So this hook owns the entries:
 * it runs after every `cordova prepare` (and on install / uninstall) and makes
 * platforms/android/app/src/main/AndroidManifest.xml contain exactly what the variables ask for:
 *
 *   ENABLE_QS_TILE=true        -> TorchTileService (Quick Settings tile). No permission.
 *   ENABLE_TORCH_SERVICE=true  -> TorchForegroundService (specialUse FGS) + FOREGROUND_SERVICE,
 *                                 FOREGROUND_SERVICE_SPECIAL_USE, POST_NOTIFICATIONS.
 *   ENABLE_SOS_TILE=true       -> SosTileService - only together with ENABLE_TORCH_SERVICE, because
 *                                 the SOS pattern runs in that service.
 *
 * All false (the default): the manifest is left byte-for-byte unchanged.
 *
 * Idempotent: services are recognised by their class names; a permission is removed again only
 * if this hook added it (recorded in platforms/android/flashlight-plugin-manifest.json), so a
 * permission another plugin or the app declares is never touched.
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_ID = 'community-cordova-plugin-flashlight';
const PKG = 'nl.xservices.plugins';
const STATE_FILE = 'flashlight-plugin-manifest.json';
const VARIABLES = ['ENABLE_QS_TILE', 'ENABLE_SOS_TILE', 'ENABLE_TORCH_SERVICE'];

const TILE_SERVICE = PKG + '.TorchTileService';
const SOS_SERVICE = PKG + '.SosTileService';
const FGS_SERVICE = PKG + '.TorchForegroundService';
const ALL_SERVICES = [TILE_SERVICE, SOS_SERVICE, FGS_SERVICE];

const FGS_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.POST_NOTIFICATIONS',
];

function isTrue(v) {
  return v === true || /^(true|1|yes|on)$/i.test(String(v == null ? '' : v).trim());
}

/** Variables -> which entries to add. */
function resolveFlags(vars) {
  vars = vars || {};
  const torchService = isTrue(vars.ENABLE_TORCH_SERVICE);
  const sosRequested = isTrue(vars.ENABLE_SOS_TILE);
  return {
    qsTile: isTrue(vars.ENABLE_QS_TILE),
    torchService,
    sosTile: sosRequested && torchService,
    sosIgnored: sosRequested && !torchService,
  };
}

function tileServiceXml(name, labelRes, iconRes, indent) {
  const i = indent;
  return [
    // Attributes in alphabetical order: cordova-android re-serialises the manifest with
    // elementtree, and a stable order keeps the idempotency check quiet.
    `${i}<service android:exported="true" android:icon="@drawable/${iconRes}" android:label="@string/${labelRes}" android:name="${name}" android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">`,
    `${i}    <intent-filter>`,
    `${i}        <action android:name="android.service.quicksettings.action.QS_TILE" />`,
    `${i}    </intent-filter>`,
    `${i}    <meta-data android:name="android.service.quicksettings.TOGGLEABLE_TILE" android:value="true" />`,
    `${i}</service>`,
  ].join('\n');
}

function fgsServiceXml(indent) {
  const i = indent;
  return [
    `${i}<service android:exported="false" android:foregroundServiceType="specialUse" android:name="${FGS_SERVICE}">`,
    `${i}    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="torch_control" />`,
    `${i}</service>`,
  ].join('\n');
}

/** Whitespace / self-closing style differences don't count (elementtree re-indents the file). */
function normalize(xml) {
  return String(xml).replace(/\s+/g, ' ').replace(/\s*\/>/g, '/>').replace(/>\s*</g, '><').trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches one <service> element (self-closing or with children) by android:name, plus its line. */
function serviceRe(name) {
  return new RegExp(
    `[ \\t]*<service\\b(?=[^>]*\\bandroid:name\\s*=\\s*["']${escapeRe(name)}["'])[^>]*?(?:/>|>[\\s\\S]*?</service\\s*>)[ \\t]*\\r?\\n?`,
    'g'
  );
}

function permissionRe(name) {
  return new RegExp(
    `[ \\t]*<uses-permission\\b(?=[^>]*\\bandroid:name\\s*=\\s*["']${escapeRe(name)}["'])[^>]*?(?:/>|>\\s*</uses-permission\\s*>)[ \\t]*\\r?\\n?`,
    'g'
  );
}

function hasPermission(xml, name) {
  return permissionRe(name).test(xml);
}

/**
 * Pure transform: returns { xml, state, changes }.
 * state = { addedPermissions: [...] } - the permissions this hook inserted earlier.
 */
function applyManifest(xml, flags, state) {
  const added = new Set((state && state.addedPermissions) || []);
  const changes = [];
  let out = xml;

  // ---- services: remove ours, then add back exactly the wanted ones
  const wanted = [];
  if (flags.qsTile) wanted.push(TILE_SERVICE);
  if (flags.sosTile) wanted.push(SOS_SERVICE);
  if (flags.torchService) wanted.push(FGS_SERVICE);

  const probe = /([ \t]*)<\/application\s*>/.exec(out);
  const indent = (probe ? probe[1] : '    ') + '    ';
  const expected = {};
  if (flags.qsTile) expected[TILE_SERVICE] = tileServiceXml(TILE_SERVICE, 'flashlight_tile_label', 'flashlight_ic_torch', indent);
  if (flags.sosTile) expected[SOS_SERVICE] = tileServiceXml(SOS_SERVICE, 'flashlight_sos_tile_label', 'flashlight_ic_sos', indent);
  if (flags.torchService) expected[FGS_SERVICE] = fgsServiceXml(indent);

  const current = {};
  for (const n of ALL_SERVICES) {
    const m = out.match(serviceRe(n));
    if (m) current[n] = m.join('');
  }
  const present = Object.keys(current);
  const sameServices = present.length === wanted.length &&
    wanted.every((n) => current[n] !== undefined && normalize(current[n]) === normalize(expected[n]));

  if (!sameServices) {
    for (const name of present) {
      out = out.replace(serviceRe(name), '');
      if (!wanted.includes(name)) changes.push(`removed service ${name}`);
    }
    if (wanted.length) {
      const m = /([ \t]*)<\/application\s*>/.exec(out);
      if (!m) {
        throw new Error('AndroidManifest.xml has no </application> to add the flashlight services to');
      }
      const blocks = wanted.map((n) => expected[n]);
      out = out.slice(0, m.index) + blocks.join('\n') + '\n' + out.slice(m.index);
      for (const name of wanted) {
        changes.push(`${present.includes(name) ? 'updated' : 'added'} service ${name}`);
      }
    }
  }

  // ---- permissions
  const wantedPerms = flags.torchService ? FGS_PERMISSIONS : [];
  for (const perm of FGS_PERMISSIONS) {
    const want = wantedPerms.includes(perm);
    const has = hasPermission(out, perm);
    if (want && !has) {
      const m = /([ \t]*)<application\b/.exec(out);
      if (!m) {
        throw new Error('AndroidManifest.xml has no <application> element');
      }
      const indent = m[1];
      out = out.slice(0, m.index) + `${indent}<uses-permission android:name="${perm}" />\n` + out.slice(m.index);
      added.add(perm);
      changes.push(`added permission ${perm}`);
    } else if (!want && has && added.has(perm)) {
      out = out.replace(permissionRe(perm), '');
      added.delete(perm);
      changes.push(`removed permission ${perm}`);
    } else if (!want && !has) {
      added.delete(perm);
    }
    // want && has: already there (ours from an earlier run, or someone else's) - leave it.
  }

  if (/<(service|uses-permission)\b[^>]*android:/.test(out) && !/xmlns:android\s*=/.test(out)) {
    throw new Error('AndroidManifest.xml does not declare the android namespace');
  }

  return { xml: out, state: { addedPermissions: Array.from(added).sort() }, changes };
}

// ------------------------------------------------------------------ variables

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function pick(obj) {
  const out = {};
  if (!obj) return out;
  for (const k of VARIABLES) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function configXmlVariables(projectRoot) {
  let xml;
  try {
    xml = fs.readFileSync(path.join(projectRoot, 'config.xml'), 'utf8');
  } catch (e) {
    return {};
  }
  const m = new RegExp(`<plugin\\b[^>]*\\bname\\s*=\\s*["']${escapeRe(PLUGIN_ID)}["'][^>]*?(?:/>|>([\\s\\S]*?)</plugin\\s*>)`).exec(xml);
  const out = {};
  if (!m || !m[1]) return out;
  const re = /<variable\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*?\bvalue\s*=\s*["']([^"']*)["']/g;
  let v;
  while ((v = re.exec(m[1]))) {
    if (VARIABLES.includes(v[1])) out[v[1]] = v[2];
  }
  return out;
}

/**
 * The variables the plugin was installed with. Lowest to highest precedence:
 * config.xml <plugin><variable>, package.json cordova.plugins, platforms/android/android.json
 * (what the installed platform actually used), then --variable values of the running command.
 */
function readVariables(projectRoot, cliVariables) {
  const pkg = readJson(path.join(projectRoot, 'package.json'));
  const platformJson = readJson(path.join(projectRoot, 'platforms', 'android', 'android.json'));
  const fromPlatform = platformJson && (
    (platformJson.installed_plugins && platformJson.installed_plugins[PLUGIN_ID]) ||
    (platformJson.dependent_plugins && platformJson.dependent_plugins[PLUGIN_ID])
  );
  return Object.assign(
    {},
    configXmlVariables(projectRoot),
    pick(pkg && pkg.cordova && pkg.cordova.plugins && pkg.cordova.plugins[PLUGIN_ID]),
    pick(fromPlatform),
    pick(cliVariables)
  );
}

function findManifest(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'platforms', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    path.join(projectRoot, 'platforms', 'android', 'AndroidManifest.xml'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** Applies the flags to the manifest on disk. Writes nothing when nothing changes. */
function run(manifestPath, statePath, flags) {
  const xml = fs.readFileSync(manifestPath, 'utf8');
  const state = readJson(statePath) || { addedPermissions: [] };
  const result = applyManifest(xml, flags, state);
  if (result.xml !== xml) {
    fs.writeFileSync(manifestPath, result.xml, 'utf8');
  }
  if (result.state.addedPermissions.length) {
    fs.writeFileSync(statePath, JSON.stringify(result.state, null, 2) + '\n', 'utf8');
  } else if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
  return result;
}

// ------------------------------------------------------------------ Cordova entry point

module.exports = function (context) {
  const opts = (context && context.opts) || {};
  const platforms = opts.platforms || (opts.cordova && opts.cordova.platforms);
  if (Array.isArray(platforms) && platforms.length && !platforms.includes('android')) {
    return;
  }
  const projectRoot = opts.projectRoot || process.cwd();
  const manifestPath = findManifest(projectRoot);
  if (!manifestPath) {
    return; // no android platform yet
  }
  const uninstalling = context.hook === 'before_plugin_uninstall';
  const flags = uninstalling
    ? resolveFlags({})
    : resolveFlags(readVariables(projectRoot, context.hook === 'after_plugin_install' ? opts.cli_variables : null));
  if (flags.sosIgnored) {
    console.warn(`[${PLUGIN_ID}] ENABLE_SOS_TILE needs ENABLE_TORCH_SERVICE=true (the SOS pattern runs in that service) - the SOS tile was not added.`);
  }
  const statePath = path.join(projectRoot, 'platforms', 'android', STATE_FILE);
  const result = run(manifestPath, statePath, flags);
  for (const c of result.changes) {
    console.log(`[${PLUGIN_ID}] AndroidManifest.xml: ${c}`);
  }
};

module.exports.applyManifest = applyManifest;
module.exports.resolveFlags = resolveFlags;
module.exports.readVariables = readVariables;
module.exports.run = run;
module.exports.STATE_FILE = STATE_FILE;
module.exports.FGS_PERMISSIONS = FGS_PERMISSIONS;
