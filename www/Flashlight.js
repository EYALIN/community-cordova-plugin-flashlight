var exec = require('cordova/exec');

var SERVICE = 'Flashlight';

function isFunction(f) {
  return typeof f === 'function';
}

function isOptions(o) {
  return o !== null && typeof o === 'object' && !isFunction(o);
}

function Flashlight() {
  // Tracked torch state. Only updated once native reports success (or, while a
  // state listener is active, whenever the torch changes from anywhere).
  this._isSwitchedOn = false;
  this._stateListeners = [];
  this._listening = false;
  this._lastState = null;
}

/**
 * Runs a native action in either style:
 *  - callback style (a success or error callback was passed): returns undefined,
 *    exactly like the 3.3.x API the @awesome-cordova-plugins wrapper relies on;
 *  - promise style (no callbacks): returns a Promise.
 * `onSuccess` runs before the caller's success callback / resolution, so state is
 * already updated when the caller observes success.
 */
Flashlight.prototype._run = function (action, args, successCallback, errorCallback, onSuccess, onError) {
  if (isFunction(successCallback) || isFunction(errorCallback)) {
    exec(function (result) {
      if (onSuccess) { result = onSuccess(result); }
      if (isFunction(successCallback)) { successCallback(result); }
    }, function (err) {
      if (onError) { onError(err); }
      if (isFunction(errorCallback)) { errorCallback(err); }
    }, SERVICE, action, args);
    return undefined;
  }
  return new Promise(function (resolve, reject) {
    exec(function (result) {
      if (onSuccess) { result = onSuccess(result); }
      resolve(result);
    }, function (err) {
      if (onError) { onError(err); }
      reject(err);
    }, SERVICE, action, args);
  });
};

Flashlight.prototype._setOn = function (on) {
  this._isSwitchedOn = on;
};

/**
 * available(callback?) - callback(boolean), never errors (native errors report false).
 * available() - Promise<boolean>, never rejects.
 */
Flashlight.prototype.available = function (callback) {
  var toBool = function (avail) { return avail ? true : false; };
  if (isFunction(callback)) {
    exec(function (avail) {
      callback(toBool(avail));
    }, function () { callback(false); }, SERVICE, 'available', []);
    return undefined;
  }
  return new Promise(function (resolve) {
    exec(function (avail) { resolve(toBool(avail)); }, function () { resolve(false); }, SERVICE, 'available', []);
  });
};

/**
 * switchOn(successCallback?, errorCallback?, options?)
 * switchOn(options?) -> Promise
 * options: { intensity: 0..1 } - iOS torch level; Android 13+ maps it onto the strength levels.
 *          { autoOffSeconds: n } - Android, needs ENABLE_TORCH_SERVICE: the torch goes off after n
 *          seconds, scheduled in the foreground service (survives the WebView being killed).
 */
Flashlight.prototype.switchOn = function (successCallback, errorCallback, options) {
  if (isOptions(successCallback)) {
    // switchOn(options, success?, error?)
    var o = successCallback;
    successCallback = errorCallback;
    errorCallback = options;
    options = o;
  }
  var self = this;
  return this._run('switchOn', [options || {}], successCallback, errorCallback, function (r) {
    self._setOn(true);
    return r;
  });
};

/**
 * switchOff(successCallback?, errorCallback?)
 * switchOff() -> Promise
 */
Flashlight.prototype.switchOff = function (successCallback, errorCallback) {
  var self = this;
  return this._run('switchOff', [], successCallback, errorCallback, function (r) {
    self._setOn(false);
    return r;
  });
};

/**
 * toggle(successCallback?, errorCallback?, options?)
 * toggle(options?) -> Promise
 */
Flashlight.prototype.toggle = function (successCallback, errorCallback, options) {
  if (this._isSwitchedOn) {
    if (isOptions(successCallback)) {
      successCallback = errorCallback;
      errorCallback = options;
    }
    return this.switchOff(successCallback, errorCallback);
  }
  return this.switchOn(successCallback, errorCallback, options);
};

/** Synchronous: the last state confirmed by native. */
Flashlight.prototype.isSwitchedOn = function () {
  return this._isSwitchedOn;
};

/**
 * getMaxStrengthLevel(success?, error?) / Promise<number>
 * Android 13+: CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL. iOS: 100 (continuous torch level).
 * 1 means brightness can't be changed on this device.
 */
Flashlight.prototype.getMaxStrengthLevel = function (successCallback, errorCallback) {
  return this._run('getMaxStrengthLevel', [], successCallback, errorCallback);
};

/** getStrengthLevel(success?, error?) / Promise<number> - the current (or default) level. */
Flashlight.prototype.getStrengthLevel = function (successCallback, errorCallback) {
  return this._run('getStrengthLevel', [], successCallback, errorCallback);
};

/**
 * switchOnWithStrength(level, success?, error?) / Promise<number>
 * Switches the torch on at `level` (1..max, clamped). Resolves with the level applied.
 * Where max is 1, it is a plain switchOn.
 */
Flashlight.prototype.switchOnWithStrength = function (level, successCallback, errorCallback) {
  var self = this;
  var n = parseInt(level, 10);
  return this._run('switchOnWithStrength', [isNaN(n) ? -1 : n], successCallback, errorCallback, function (r) {
    self._setOn(true);
    return r;
  });
};

/**
 * onStateChange(callback) - callback({isOn, available, strengthLevel, maxStrengthLevel}).
 * Fires with the current state on registration, then on every torch change from any
 * source (this app, other apps, the system Quick Settings / Control Center toggle).
 * Returns the callback, for offStateChange.
 */
Flashlight.prototype.onStateChange = function (callback) {
  if (!isFunction(callback)) {
    throw new TypeError('flashlight.onStateChange expects a function');
  }
  if (this._stateListeners.indexOf(callback) === -1) {
    this._stateListeners.push(callback);
  }
  if (!this._listening) {
    this._startNativeListener();
  } else if (this._lastState) {
    // Late subscriber: hand it the current state right away, like the first one got.
    var state = this._lastState;
    setTimeout(function () { callback(state); }, 0);
  }
  return callback;
};

/** offStateChange(callback?) - removes one listener, or all when called without one. */
Flashlight.prototype.offStateChange = function (callback) {
  if (callback === undefined) {
    this._stateListeners = [];
  } else {
    var i = this._stateListeners.indexOf(callback);
    if (i !== -1) { this._stateListeners.splice(i, 1); }
  }
  if (this._stateListeners.length === 0 && this._listening) {
    this._listening = false;
    this._lastState = null;
    exec(null, null, SERVICE, 'stopStateListener', []);
  }
};

Flashlight.prototype._startNativeListener = function () {
  var self = this;
  this._listening = true;
  exec(function (state) {
    // A release (NO_RESULT) from stopStateListener arrives with no payload.
    if (!self._listening || !isOptions(state)) { return; }
    self._lastState = state;
    self._isSwitchedOn = !!state.isOn;
    var listeners = self._stateListeners.slice();
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](state);
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) { console.error('flashlight state listener threw', e); }
      }
    }
  }, function (err) {
    self._listening = false;
    if (typeof console !== 'undefined' && console.warn) { console.warn('flashlight state listener failed', err); }
  }, SERVICE, 'startStateListener', []);
};

// ---------------------------------------------------------------- Android extras (3.5.0)
// Opt-in per app with plugin variables (ENABLE_QS_TILE, ENABLE_TORCH_SERVICE, ENABLE_SOS_TILE).
// Without the variable the native side answers with an error naming it. Other platforms reject
// (getFeatures resolves with everything false).

function isAndroid() {
  return typeof cordova !== 'undefined' && cordova && cordova.platformId === 'android';
}

Flashlight.prototype._androidOnly = function (method, action, args, successCallback, errorCallback, onSuccess) {
  if (isAndroid()) {
    return this._run(action, args, successCallback, errorCallback, onSuccess);
  }
  var platform = (typeof cordova !== 'undefined' && cordova && cordova.platformId) || 'this platform';
  var err = 'flashlight.' + method + ' is not supported on ' + platform + ' (Android only)';
  if (isFunction(successCallback) || isFunction(errorCallback)) {
    if (isFunction(errorCallback)) { setTimeout(function () { errorCallback(err); }, 0); }
    return undefined;
  }
  return Promise.reject(err);
};

/** Splits (options?, success?, error?) where options may be omitted. */
function optionsFirst(options, successCallback, errorCallback) {
  if (isFunction(options)) {
    return { options: {}, success: options, error: successCallback };
  }
  return { options: isOptions(options) ? options : {}, success: successCallback, error: errorCallback };
}

/**
 * startPattern({ type: 'sos' | 'strobe', hz? }, success?, error?) / Promise<{type, hz?}>
 * Runs a blink pattern natively in the foreground service (needs ENABLE_TORCH_SERVICE), so it keeps
 * going without the WebView. Strobe defaults to 10 Hz and is capped at 20 Hz.
 */
Flashlight.prototype.startPattern = function (options, successCallback, errorCallback) {
  var a = optionsFirst(options, successCallback, errorCallback);
  return this._androidOnly('startPattern', 'startPattern', [a.options], a.success, a.error);
};

/** stopPattern(success?, error?) / Promise<void> - stops a running pattern and the torch. */
Flashlight.prototype.stopPattern = function (successCallback, errorCallback) {
  return this._androidOnly('stopPattern', 'stopPattern', [], successCallback, errorCallback);
};

/**
 * setOngoingNotification({ enabled, title?, offLabel?, channelName? }, success?, error?)
 *   / Promise<{ enabled, permission: 'granted' | 'denied' | 'not-required' }>
 * Whether switching the torch on shows the "Flashlight is on" notification (default: enabled),
 * and its translated strings. Enabling it asks for POST_NOTIFICATIONS on Android 13+.
 */
Flashlight.prototype.setOngoingNotification = function (options, successCallback, errorCallback) {
  var a = optionsFirst(options, successCallback, errorCallback);
  return this._androidOnly('setOngoingNotification', 'setOngoingNotification', [a.options], a.success, a.error);
};

/**
 * requestAddTile({ tile?: 'torch' | 'sos' }?, success?, error?) / Promise<number>
 * Android 13+: asks the user to add the Quick Settings tile (StatusBarManager.requestAddTileService).
 * Resolves with the result code: 2 added, 1 already added, 0 not added, >= 1000 an error code.
 */
Flashlight.prototype.requestAddTile = function (options, successCallback, errorCallback) {
  var a = optionsFirst(options, successCallback, errorCallback);
  return this._androidOnly('requestAddTile', 'requestAddTile', [a.options], a.success, a.error);
};

/** requestAddTile result codes (StatusBarManager.TILE_ADD_REQUEST_*). */
Flashlight.prototype.TILE_ADD_RESULT = {
  NOT_ADDED: 0,
  ALREADY_ADDED: 1,
  ADDED: 2
};

var NO_FEATURES = {
  qsTile: false,
  sosTile: false,
  torchService: false,
  ongoingNotification: false,
  canRequestAddTile: false,
  runningPattern: null
};

/**
 * getFeatures(success?, error?) / Promise<{qsTile, sosTile, torchService, ongoingNotification,
 * canRequestAddTile, runningPattern}> - which opt-in extras this build has. All false off Android.
 */
Flashlight.prototype.getFeatures = function (successCallback, errorCallback) {
  if (isAndroid()) {
    return this._run('getFeatures', [], successCallback, errorCallback);
  }
  var copy = {};
  for (var k in NO_FEATURES) { copy[k] = NO_FEATURES[k]; }
  if (isFunction(successCallback) || isFunction(errorCallback)) {
    if (isFunction(successCallback)) { setTimeout(function () { successCallback(copy); }, 0); }
    return undefined;
  }
  return Promise.resolve(copy);
};

var flashlight = new Flashlight();

Flashlight.install = function () {
  if (!window.plugins) {
    window.plugins = {};
  }

  window.plugins.flashlight = flashlight;
  return window.plugins.flashlight;
};

cordova.addConstructor(Flashlight.install);

// plugin.xml clobbers window.plugins.flashlight with this same instance.
module.exports = flashlight;
