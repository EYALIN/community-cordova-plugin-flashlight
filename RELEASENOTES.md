# Release Notes

### 3.5.0 (Sep 26, 2026)

New (Android, all opt-in per app - without the variables nothing changes: no tile, no service,
no permission):
-   **Quick Settings tile** (`--variable ENABLE_QS_TILE=true`, APP-148). `TorchTileService`
    toggles the torch on the plugin's back-camera flash unit; its state follows a
    `CameraManager.TorchCallback` while the panel is open, `STATE_UNAVAILABLE` without a flash unit
    or while another app holds the camera. `TOGGLEABLE_TILE` meta-data for Android 13+.
    `requestAddTile()` asks the user to add it on Android 13+ (`StatusBarManager.requestAddTileService`)
    and resolves the result code.
-   **SOS tile** (`--variable ENABLE_SOS_TILE=true`, needs `ENABLE_TORCH_SERVICE`). A tap starts the
    native SOS pattern, a second tap stops it.
-   **"Flashlight is on" ongoing notification** (`--variable ENABLE_TORCH_SERVICE=true`, APP-151).
    `TorchForegroundService` (`specialUse`, subtype `torch_control`) starts when the torch goes on
    through the plugin or a tile and stops when it goes off from any source. Silent, low-importance
    channel; "Turn off" action; tapping opens the app. `setOngoingNotification({ enabled, title?,
    offLabel?, channelName? })` sets translated strings and asks for `POST_NOTIFICATIONS` on
    Android 13+ when enabling. `setOngoingNotification({ paused })` suspends / resumes it in memory
    only (no saved setting or string changes, never asks), for apps that blink the torch from JS.
-   `switchOn({ autoOffSeconds })`: the off is scheduled in the service, so it fires even if the
    WebView is killed.
-   `startPattern({ type: 'sos' | 'strobe', hz })` / `stopPattern()`: blink patterns on a
    `HandlerThread` in the service; strobe capped at 20 Hz. A plain `switchOn` / `switchOff` stops a
    running pattern.
-   `getFeatures()`: which of the extras this build has (all false off Android).
-   The manifest entries come from `hooks/android-manifest.js` (after_prepare / after_plugin_install
    / before_plugin_uninstall), because a `<config-file>` can't depend on a variable and manifest
    placeholders can't remove a permission. See the README, "How the opt-in works".
-   Tests for the hook (variables off = manifest unchanged byte for byte; on = the expected nodes;
    idempotent; toggling off removes only what it added) and for the new JS API.

Hardening (pre-release review):
-   `switchOff()` during a native pattern's dark phase left the torch off but the service - and its
    "Flashlight is on" notification - running, because no `TorchCallback` fires when the torch is
    already off. The plugin now tells the service directly.
-   The service never stops before its `startForeground()`: a torch callback that arrived before
    `onStartCommand` (e.g. camera already in use) could stop a `startForegroundService()` start and
    crash the app. `stopSelf(startId)` also keeps a start that is still queued (a quick second tap).
-   `stopPattern` (sent with `startService`) no longer calls `startForeground()`, which throws on
    Android 12+ when it runs from the background after the service left the foreground.
-   Pattern start / halt are synchronized (the plugin thread pool and the main thread both reach them).
-   `PermissionHelper` (deprecated in cordova-android 15) replaced with `cordova.hasPermission` /
    `cordova.requestPermission`.
-   iOS: torch KVO events are emitted on the main thread.

Unchanged: every 3.4.0 method, callback signature and native action, so
`@awesome-cordova-plugins/flashlight` works as before. The torch camera selection moved into a
shared `TorchCamera` helper (same logic) so the plugin, the tiles and the service use one camera.

### 3.4.0 (Sep 26, 2026)

New:
-   **Brightness / strength levels.** `getMaxStrengthLevel()`, `getStrengthLevel()` and
    `switchOnWithStrength(level)`. Android 13+ (API 33) uses
    `CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL` and
    `CameraManager.turnOnTorchWithStrengthLevel`; iOS maps the continuous torch level onto 1..100.
    A max of 1 means the device can't dim (always the case below Android 13).
-   `switchOn({intensity})` now also dims on Android 13+ hardware that supports it (it was iOS-only).
-   **Torch-state listener.** `onStateChange(cb)` / `offStateChange(cb?)`. Fires with the current
    state on registration, then whenever the torch changes from anywhere - this app, another app,
    the Android Quick Settings tile. Android: `CameraManager.TorchCallback`; iOS: KVO on
    `torchActive` / `torchAvailable` / `torchLevel`.
-   **Promise API.** `available()`, `switchOn()`, `switchOff()`, `toggle()` and the new
    strength calls return a Promise when called without callbacks. The callback signatures are
    unchanged, so `@awesome-cordova-plugins/flashlight` keeps working as before.
-   TypeScript definitions in `types/index.d.ts`.
-   JS unit tests (`npm test`, Node 18+, no dependencies).

Fixes:
-   `isSwitchedOn()` changed before native answered, so a failed switch (camera busy,
    no torch) left it wrong and the next `toggle()` went the wrong way. It now changes only in
    the native success callback, and follows the state listener while one is registered.
-   Android: every action answered a shared `callbackContext` field, so overlapping calls could
    answer each other's callbacks. Each call now answers its own.
-   Android: prefer the back-facing camera's flash unit; `CameraAccessException` errors now say why
    (camera in use, disabled by policy, ...). The legacy `android.hardware.Camera` path for
    Android 5 and older was removed (cordova-android 12+ requires API 24).
-   iOS: `lockForConfiguration` and `setTorchModeOnWithLevel` errors were ignored and success was
    reported anyway; they are now reported. A requested level above the current thermal maximum
    falls back to the maximum instead of failing. Dropped the deprecated `setFlashMode:` calls.
-   iOS: `available()` now checks `hasTorch` + torch-mode support (it also required `hasFlash`).
-   plugin.xml version was stuck at 3.2.0 while npm shipped 3.3.x; plugin.xml and package.json
    now carry the same version, and repo / issue / homepage links point at
    EYALIN/community-cordova-plugin-flashlight instead of the upstream project.

### 3.3.3

-   Removed the Android compat dependency. (Published to npm without a version-bump commit;
    plugin.xml still said 3.2.0.)

### 3.3.1 - 3.3.2

-   Removed the Android camera permission (the torch API doesn't need it).
