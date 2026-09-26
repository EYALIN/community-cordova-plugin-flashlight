[![NPM version](https://img.shields.io/npm/v/community-cordova-plugin-flashlight)](https://www.npmjs.com/package/community-cordova-plugin-flashlight)
[![Downloads](https://img.shields.io/npm/dm/community-cordova-plugin-flashlight)](https://www.npmjs.com/package/community-cordova-plugin-flashlight)

# community-cordova-plugin-flashlight

Cordova plugin to switch the flashlight / torch on and off, set its brightness, and follow
its state. A maintained fork of Eddy Verbruggen's
[Flashlight-PhoneGap-Plugin](https://github.com/EddyVerbruggen/Flashlight-PhoneGap-Plugin).

1. [Features](#1-features)
2. [Installation](#2-installation)
3. [Usage](#3-usage)
4. [API](#4-api)
5. [Android extras (opt-in)](#5-android-extras-opt-in)
6. [Credits](#6-credits)

## 1. Features

* Switch the torch on / off / toggle - Android 6+ and iOS
* Brightness: strength levels on Android 13+ (hardware permitting) and the torch level on iOS
* State listener: know when the torch changes from anywhere - including the Android Quick
  Settings tile or another app
* Callback **and** Promise API
* No camera permission needed
* Android, opt-in per app: a Quick Settings tile, an SOS tile, and a "Flashlight is on"
  notification with a native auto-off timer and SOS / strobe patterns - see
  [Android extras](#5-android-extras-opt-in)
* TypeScript definitions (`types/index.d.ts`)

## 2. Installation

```
$ cordova plugin add community-cordova-plugin-flashlight
```

From GitHub:
```
$ cordova plugin add https://github.com/EYALIN/community-cordova-plugin-flashlight
```

## 3. Usage

Every method (except `isSwitchedOn`, `onStateChange`, `offStateChange`) works in two styles:
pass callbacks and it returns nothing (the 3.3.x behaviour), or pass no callbacks and it
returns a Promise.

```javascript
const flashlight = window.plugins.flashlight;

// Promise style
if (await flashlight.available()) {
  await flashlight.switchOn();
  console.log(flashlight.isSwitchedOn()); // true
  await flashlight.switchOff();
}

// Callback style (unchanged from 3.3.x)
flashlight.available(function (isAvailable) {
  if (isAvailable) {
    flashlight.switchOn(
      function () {},          // optional success callback
      function (err) {},       // optional error callback
      { intensity: 0.3 }       // optional
    );
  }
});
```

### Brightness

```javascript
const max = await flashlight.getMaxStrengthLevel(); // 1 = can't dim on this device
if (max > 1) {
  slider.max = max;
  slider.oninput = () => flashlight.switchOnWithStrength(Number(slider.value));
}
```

| Platform | `getMaxStrengthLevel()` |
|---|---|
| Android 13+ with dimmable flash | `CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL` (e.g. 5, 45, 100 - device specific) |
| Android 13+ without, Android 12 and older | `1` |
| iOS with a torch | `100` (the continuous torch level mapped onto 1..100) |

`switchOn({intensity: 0..1})` still works too: iOS uses it as the torch level, Android 13+
maps it onto the strength levels.

### Following the torch state

```javascript
const listener = flashlight.onStateChange(function (state) {
  // { isOn: true, available: true, strengthLevel: 3, maxStrengthLevel: 5 }
  toggleButton.checked = state.isOn;
});

// later
flashlight.offStateChange(listener); // or offStateChange() to remove all
```

The listener fires once with the current state right after registering, then whenever the
torch changes - from this app, another app, or the system Quick Settings tile (Android) /
Control Center (iOS, while the app is in the foreground). `available: false` means the torch
can't be used right now (e.g. another app has the camera open). While a listener is
registered, `isSwitchedOn()` follows these events too.

### Android back button

Switch the torch off when the app exits via the back button, so other apps can use the camera:
```javascript
document.addEventListener("backbutton", function () {
  flashlight.switchOff(exitApp, exitApp);
}, false);

function exitApp() {
  navigator.app.exitApp();
}
```

## 4. API

| Method | Callback style | Promise style |
|---|---|---|
| `available` | `available(cb(boolean))` | `available(): Promise<boolean>` - never rejects |
| `switchOn` | `switchOn(success?, error?, options?)` | `switchOn(options?): Promise<void>` |
| `switchOff` | `switchOff(success?, error?)` | `switchOff(): Promise<void>` |
| `toggle` | `toggle(success?, error?, options?)` | `toggle(options?): Promise<void>` |
| `isSwitchedOn` | `isSwitchedOn(): boolean` (sync) | |
| `getMaxStrengthLevel` | `getMaxStrengthLevel(success(n), error?)` | `getMaxStrengthLevel(): Promise<number>` |
| `getStrengthLevel` | `getStrengthLevel(success(n), error?)` | `getStrengthLevel(): Promise<number>` |
| `switchOnWithStrength` | `switchOnWithStrength(level, success?, error?)` | `switchOnWithStrength(level): Promise<number \| undefined>` - the level applied; `undefined` where the max is 1 |
| `onStateChange` | `onStateChange(cb(state)): cb` | |
| `offStateChange` | `offStateChange(cb?)` | |

`isSwitchedOn()` reflects what native confirmed: it changes only when a switch call succeeds
(or a state event arrives), never optimistically.

Android extras (need a plugin variable, see below; rejected on iOS):

| Method | Callback style | Promise style |
|---|---|---|
| `startPattern` | `startPattern(options, success?, error?)` | `startPattern(options?): Promise<{type, hz?}>` |
| `stopPattern` | `stopPattern(success?, error?)` | `stopPattern(): Promise<void>` |
| `setOngoingNotification` | `setOngoingNotification(options, success?, error?)` | `setOngoingNotification(options): Promise<{enabled, paused, permission}>` |
| `requestAddTile` | `requestAddTile(options?, success?, error?)` | `requestAddTile(options?): Promise<number>` |
| `getFeatures` | `getFeatures(success?, error?)` | `getFeatures(): Promise<Features>` - all false off Android |

`switchOn` also takes `{ autoOffSeconds }` on Android (needs `ENABLE_TORCH_SERVICE`).

`@awesome-cordova-plugins/flashlight` keeps working unchanged - it calls the callback style.

## 5. Android extras (opt-in)

Three plugin variables, all `false` by default. An app that doesn't set them gets **no tile, no
service and no new permission** - its merged manifest is exactly what 3.4.0 produced.

| Variable | Adds to the manifest | Permissions added |
|---|---|---|
| `ENABLE_QS_TILE` | `TorchTileService` - Quick Settings "Flashlight" tile | none (the tile is bound with `BIND_QUICK_SETTINGS_TILE`, a system permission) |
| `ENABLE_TORCH_SERVICE` | `TorchForegroundService` - `specialUse` foreground service | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS` |
| `ENABLE_SOS_TILE` | `SosTileService` - Quick Settings "SOS" tile | none. **Needs `ENABLE_TORCH_SERVICE`** (the pattern runs in that service); set alone it is ignored with a warning |

```
cordova plugin add community-cordova-plugin-flashlight \
  --variable ENABLE_QS_TILE=true \
  --variable ENABLE_TORCH_SERVICE=true \
  --variable ENABLE_SOS_TILE=true
```

or in `package.json` (what `cordova plugin add` writes):

```json
"cordova": { "plugins": { "community-cordova-plugin-flashlight": {
  "ENABLE_QS_TILE": "true", "ENABLE_TORCH_SERVICE": "true", "ENABLE_SOS_TILE": "false"
} } }
```

Changing a variable on an installed plugin: `cordova plugin rm` + `add` with the new value (Cordova
keeps the variables the platform was installed with in `platforms/android/android.json`, and that
is what the hook reads first).

### How the opt-in works

Cordova can't make a `<config-file>` depend on a variable, and manifest placeholders
(`android:enabled="${...}"`) can disable a component but can't remove a `<uses-permission>` - the
permissions would still reach the merged manifest and the Play Console. So the entries are owned
by `hooks/android-manifest.js`, which runs `after_prepare` (every `cordova prepare` / `build`),
`after_plugin_install` and `before_plugin_uninstall`, and makes
`platforms/android/app/src/main/AndroidManifest.xml` contain exactly what the variables ask for:

* all variables off: the manifest is not written at all;
* services are found by class name, so reruns are no-ops (also after cordova-android re-indents the
  file) and an outdated definition is replaced;
* a permission is removed again only if the hook added it (recorded in
  `platforms/android/flashlight-plugin-manifest.json`), so a permission the app or another plugin
  declares is never touched;
* variables are read from `platforms/android/android.json`, then `package.json`
  `cordova.plugins`, then `config.xml` `<variable>`.

The Java classes and the `flashlight_*` string / drawable resources are always compiled in; without
their manifest entry they are inert. `getFeatures()` tells the app at runtime what the build has.

### Quick Settings tile (`ENABLE_QS_TILE`)

The tile toggles the torch on the same back-camera flash unit the plugin uses. Its state follows a
`CameraManager.TorchCallback` while the panel is open, so it is right whoever switched the torch;
it is unavailable when there's no flash unit or another app holds the camera. With
`ENABLE_TORCH_SERVICE` too, switching on from the tile also starts the ongoing notification.

Android 13+ can ask the user to add it:

```javascript
const f = await flashlight.getFeatures();
if (f.canRequestAddTile) {
  const code = await flashlight.requestAddTile();          // or { tile: 'sos' }
  // 2 = added, 1 = already added, 0 = user said no, >= 1000 = StatusBarManager error
}
```

It must be called while the app is in the foreground (e.g. from a button). Below Android 13 it
rejects - the user adds the tile from the Quick Settings editor.

### Ongoing notification, auto-off and patterns (`ENABLE_TORCH_SERVICE`)

Android switches the torch off when the process that switched it on dies. With the service, the
torch - and its timer or blink pattern - keeps going after the user leaves the app, and an ongoing
low-importance, silent notification ("Flashlight is on", with a **Turn off** action; tapping it
opens the app) shows it is on. The service stops as soon as the torch goes off from any source.

```javascript
// Once, e.g. at startup: translated strings (persisted natively, also used by the tiles).
// Enabling asks for POST_NOTIFICATIONS on Android 13+ (the only place the plugin asks).
const { permission } = await flashlight.setOngoingNotification({
  enabled: true,
  title: t('Flashlight is on'),
  offLabel: t('Turn off'),
  channelName: t('Flashlight'),
});

await flashlight.switchOn({ autoOffSeconds: 600 });      // off after 10 minutes, even if the app is killed

await flashlight.startPattern({ type: 'sos' });
await flashlight.startPattern({ type: 'strobe', hz: 8 }); // capped at 20 Hz
await flashlight.stopPattern();                           // also: switchOff() / switchOn() stop a pattern
```

* The notification is on by default once the service is in the build; `setOngoingNotification({
  enabled: false })` keeps plain `switchOn()` from starting the service. `autoOffSeconds` and
  patterns always run in the service, so they always show it.
* `setOngoingNotification({ paused: true })` / `({ paused: false })` suspends it while the app blinks
  the torch itself (a JS SOS / strobe would otherwise start and stop the service on every blink).
  In memory only: the saved `enabled` setting and the strings are kept, nothing is asked (so it is
  safe after the user refused `POST_NOTIFICATIONS`), and a new process starts unpaused.
* Without `POST_NOTIFICATIONS` (denied, or never asked) the service still runs - Android just
  hides the notification (it stays visible in the task manager).
* `switchOn({ autoOffSeconds })` without the service rejects and leaves the torch off.
* While a pattern runs, `onStateChange` listeners see every blink.
* The notification strings can also be translated as Android resources
  (`flashlight_notification_title`, `flashlight_notification_off`,
  `flashlight_notification_channel`, `flashlight_tile_label`, `flashlight_sos_tile_label`).

### Foreground service type and the Play Console declaration

The service is `android:foregroundServiceType="specialUse"` with
`PROPERTY_SPECIAL_USE_FGS_SUBTYPE = "torch_control"`. Not `camera`: that type is for apps that keep
a camera device open, and on Android 14+ it requires the `CAMERA` runtime permission.
`CameraManager.setTorchMode` never opens the camera and needs no permission, so `camera` would
force a permission prompt for nothing. No other type describes a torch.

An app that enables `ENABLE_TORCH_SERVICE` must declare it in Play Console (App content ->
Foreground service permissions -> Special use). Declaration text to adapt:

> **Special use: flashlight (torch) control.** When the user switches the flashlight on in the
> app (or from its Quick Settings tile), a foreground service keeps the torch lit and shows an
> ongoing "Flashlight is on" notification with a "Turn off" action. The same service runs the
> user-requested auto-off timer and the SOS / strobe signal the user starts. Android switches the
> torch off when the process that switched it on is stopped, so without the foreground service the
> light, the timer and the SOS signal would stop as soon as the user leaves the app - which is
> exactly when a flashlight is used. The service starts only on an explicit user action and stops
> as soon as the torch is turned off, from the notification, the app, the system or the timer. The
> "camera" type does not apply: the app never opens the camera; it uses
> CameraManager.setTorchMode, which needs no camera permission.

Play also asks for a short video of the feature: record switching the torch on, leaving the app,
the notification, and **Turn off**.

## 6. Credits

* Original plugin by [Eddy Verbruggen](https://github.com/EddyVerbruggen/Flashlight-PhoneGap-Plugin).
* The Android code was inspired by the [PhoneGap Torch plugin](https://github.com/phonegap/phonegap-plugins/tree/DEPRECATED/Android/Torch).
* The iOS code was inspired by [Tom Schreck](https://github.com/tomschreck/iOS-Torch-Plugin).
