// Type definitions for community-cordova-plugin-flashlight 3.5
// Project: https://github.com/EYALIN/community-cordova-plugin-flashlight

export interface FlashlightSwitchOnOptions {
  /**
   * Torch brightness, 0.0 (exclusive) to 1.0. iOS: the torch level. Android 13+:
   * mapped onto the strength levels when the hardware supports dimming. Ignored elsewhere.
   */
  intensity?: number;
  /**
   * Android, needs the plugin variable ENABLE_TORCH_SERVICE=true: switch the torch off after this
   * many seconds. Scheduled in the foreground service, so it fires even if the WebView is killed.
   * Rejected (torch left off) when the service isn't in the build. Ignored on iOS.
   */
  autoOffSeconds?: number;
}

export type FlashlightPatternType = 'sos' | 'strobe';

export interface FlashlightPatternOptions {
  /** Default 'sos'. */
  type?: FlashlightPatternType;
  /** Strobe frequency; default 10, capped at 20. Ignored for 'sos'. */
  hz?: number;
}

export interface FlashlightPatternResult {
  type: FlashlightPatternType;
  /** The applied (clamped) frequency, strobe only. */
  hz?: number;
}

export interface FlashlightOngoingNotificationOptions {
  /** Show the "Flashlight is on" notification when the torch is switched on. Default true. */
  enabled: boolean;
  /** Notification title. Default "Flashlight is on" (or the app's flashlight_notification_title string). */
  title?: string;
  /** Label of the off action. Default "Turn off". */
  offLabel?: string;
  /** Notification channel name shown in the system settings. Default "Flashlight". */
  channelName?: string;
}

/**
 * Pause / resume the notification while the app blinks the torch itself (a JS SOS or strobe), so each
 * blink does not start the service. In memory only: the saved `enabled` setting and the strings stay,
 * nothing is asked, and a new app process is not paused.
 */
export interface FlashlightOngoingNotificationPauseOptions {
  paused: boolean;
}

export interface FlashlightOngoingNotificationResult {
  /** The saved setting (a pause does not change it). */
  enabled: boolean;
  /** A setOngoingNotification({paused: true}) is in effect. */
  paused?: boolean;
  /** POST_NOTIFICATIONS: 'not-required' below Android 13. */
  permission: 'granted' | 'denied' | 'not-required';
}

export interface FlashlightRequestAddTileOptions {
  /** Default 'torch'. 'sos' needs ENABLE_SOS_TILE. */
  tile?: 'torch' | 'sos';
}

/**
 * StatusBarManager.TILE_ADD_REQUEST_RESULT_* (0 not added, 1 already added, 2 added) or
 * TILE_ADD_REQUEST_ERROR_* (1000 and up).
 */
export type FlashlightTileAddResult = number;

export interface FlashlightFeatures {
  /** ENABLE_QS_TILE: the Quick Settings tile is in the manifest. */
  qsTile: boolean;
  /** ENABLE_SOS_TILE (+ ENABLE_TORCH_SERVICE): the SOS tile is in the manifest. */
  sosTile: boolean;
  /** ENABLE_TORCH_SERVICE: the foreground service is in the manifest. */
  torchService: boolean;
  /** The service is present and setOngoingNotification hasn't disabled the notification. */
  ongoingNotification: boolean;
  /** requestAddTile() can work: qsTile on Android 13+. */
  canRequestAddTile: boolean;
  /** The native pattern running right now, if any. */
  runningPattern: FlashlightPatternType | null;
}

export interface FlashlightState {
  /** Whether the torch is currently lit. */
  isOn: boolean;
  /** False while the torch can't be used (e.g. another app holds the camera, or thermal limits on iOS). */
  available: boolean;
  /** Current strength level (1..maxStrengthLevel) while on, 0 while off. */
  strengthLevel: number;
  /** Highest strength level; 1 means the brightness can't be changed. */
  maxStrengthLevel: number;
}

export type FlashlightStateListener = (state: FlashlightState) => void;

export interface FlashlightPlugin {
  /** Callback style (3.3.x compatible). Reports false on any native error. */
  available(callback: (isAvailable: boolean) => void): void;
  /** Promise style. Never rejects; resolves false on any native error. */
  available(): Promise<boolean>;

  /** Callback style (3.3.x compatible). `isSwitchedOn()` is true before `successCallback` runs. */
  switchOn(successCallback?: () => void, errorCallback?: (error: string) => void, options?: FlashlightSwitchOnOptions): void;
  /** Promise style. */
  switchOn(options?: FlashlightSwitchOnOptions): Promise<void>;

  switchOff(successCallback: () => void, errorCallback?: (error: string) => void): void;
  switchOff(): Promise<void>;

  toggle(successCallback?: () => void, errorCallback?: (error: string) => void, options?: FlashlightSwitchOnOptions): void;
  toggle(options?: FlashlightSwitchOnOptions): Promise<void>;

  /** The last torch state confirmed by native (success callbacks, or state-listener events). */
  isSwitchedOn(): boolean;

  /**
   * Highest strength level. Android 13+: CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL.
   * iOS: 100 (the continuous torch level mapped onto 1..100). 1 = brightness can't be changed.
   */
  getMaxStrengthLevel(successCallback: (max: number) => void, errorCallback?: (error: string) => void): void;
  getMaxStrengthLevel(): Promise<number>;

  /** Current strength level. Android: the torch's configured level (even while off). iOS: 0 while off. 1 where unsupported. */
  getStrengthLevel(successCallback: (level: number) => void, errorCallback?: (error: string) => void): void;
  getStrengthLevel(): Promise<number>;

  /**
   * Switches the torch on at `level` (clamped to 1..max). Resolves with the level applied where
   * dimming is supported; where the max is 1 it behaves exactly like switchOn().
   */
  switchOnWithStrength(level: number, successCallback: (level?: number) => void, errorCallback?: (error: string) => void): void;
  switchOnWithStrength(level: number): Promise<number | undefined>;

  /**
   * Listens to torch changes from any source (this app, other apps, the Quick Settings tile /
   * Control Center). Fires once with the current state right after registering.
   * Returns the callback, to pass to offStateChange.
   */
  onStateChange(callback: FlashlightStateListener): FlashlightStateListener;
  /** Removes one listener, or all of them when called without an argument. */
  offStateChange(callback?: FlashlightStateListener): void;

  // ---- Android extras (3.5.0). Opt-in with plugin variables; rejected on other platforms.

  /** Android, ENABLE_TORCH_SERVICE: runs an SOS / strobe pattern natively in the foreground service. */
  startPattern(options: FlashlightPatternOptions, successCallback: (result: FlashlightPatternResult) => void, errorCallback?: (error: string) => void): void;
  startPattern(options?: FlashlightPatternOptions): Promise<FlashlightPatternResult>;

  /** Android: stops a running pattern (and the torch). Resolves also when nothing was running. */
  stopPattern(successCallback: () => void, errorCallback?: (error: string) => void): void;
  stopPattern(): Promise<void>;

  /**
   * Android, ENABLE_TORCH_SERVICE: turns the "Flashlight is on" notification on/off and sets its
   * translated strings (persisted, also used when a tile starts the service). Enabling it asks for
   * POST_NOTIFICATIONS on Android 13+. `{paused}` suspends / resumes it without saving or asking.
   */
  setOngoingNotification(options: FlashlightOngoingNotificationOptions | FlashlightOngoingNotificationPauseOptions, successCallback: (result: FlashlightOngoingNotificationResult) => void, errorCallback?: (error: string) => void): void;
  setOngoingNotification(options: FlashlightOngoingNotificationOptions | FlashlightOngoingNotificationPauseOptions): Promise<FlashlightOngoingNotificationResult>;

  /** Android 13+, ENABLE_QS_TILE: asks the user to add the Quick Settings tile. */
  requestAddTile(successCallback: (result: FlashlightTileAddResult) => void, errorCallback?: (error: string) => void): void;
  requestAddTile(options: FlashlightRequestAddTileOptions, successCallback: (result: FlashlightTileAddResult) => void, errorCallback?: (error: string) => void): void;
  requestAddTile(options?: FlashlightRequestAddTileOptions): Promise<FlashlightTileAddResult>;

  /** requestAddTile result codes. */
  readonly TILE_ADD_RESULT: { readonly NOT_ADDED: 0; readonly ALREADY_ADDED: 1; readonly ADDED: 2 };

  /** Which opt-in extras this build has. Resolves all-false off Android. Never needs a variable. */
  getFeatures(successCallback: (features: FlashlightFeatures) => void, errorCallback?: (error: string) => void): void;
  getFeatures(): Promise<FlashlightFeatures>;
}

/**
 * The plugin instance, available as `window.plugins.flashlight` after deviceready.
 * (Window is not augmented here, so this never conflicts with an app's own `plugins` typing.)
 */
declare const flashlight: FlashlightPlugin;
export default flashlight;
