package nl.xservices.plugins;

import android.app.StatusBarManager;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Torch control for Android 6+ via CameraManager.
 *
 * Every action answers on the CallbackContext it was invoked with (no shared
 * field), so concurrent calls can't answer each other's callbacks.
 *
 * State listener: a single persistent callback (keepCallback) fed by a
 * CameraManager.TorchCallback, so changes made anywhere - this app, another app,
 * the system Quick Settings tile - reach JS.
 *
 * Strength levels (API 33+): FLASH_INFO_STRENGTH_MAXIMUM_LEVEL, getTorchStrengthLevel,
 * turnOnTorchWithStrengthLevel. Below API 33, or on hardware without dimming,
 * the maximum level is 1.
 *
 * Opt-in Android extras (3.5.0), each present only when the app sets the plugin variable - the
 * after_prepare hook adds the manifest entries:
 *  - ENABLE_QS_TILE: TorchTileService (Quick Settings tile) + requestAddTile();
 *  - ENABLE_TORCH_SERVICE: TorchForegroundService ("Flashlight is on" notification, autoOffSeconds,
 *    startPattern / stopPattern, setOngoingNotification);
 *  - ENABLE_SOS_TILE (needs ENABLE_TORCH_SERVICE): SosTileService.
 * Without them, these actions answer an error saying which variable is missing.
 */
public class Flashlight extends CordovaPlugin {

  private static final String TAG = "Flashlight";

  private static final String ACTION_AVAILABLE = "available";
  private static final String ACTION_SWITCH_ON = "switchOn";
  private static final String ACTION_SWITCH_OFF = "switchOff";
  private static final String ACTION_GET_MAX_STRENGTH = "getMaxStrengthLevel";
  private static final String ACTION_GET_STRENGTH = "getStrengthLevel";
  private static final String ACTION_SWITCH_ON_WITH_STRENGTH = "switchOnWithStrength";
  private static final String ACTION_START_STATE_LISTENER = "startStateListener";
  private static final String ACTION_STOP_STATE_LISTENER = "stopStateListener";
  private static final String ACTION_START_PATTERN = "startPattern";
  private static final String ACTION_STOP_PATTERN = "stopPattern";
  private static final String ACTION_SET_ONGOING_NOTIFICATION = "setOngoingNotification";
  private static final String ACTION_REQUEST_ADD_TILE = "requestAddTile";
  private static final String ACTION_GET_FEATURES = "getFeatures";

  private static final String POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";
  private static final int REQ_POST_NOTIFICATIONS = 0x464C;

  private static final String NOT_CAPABLE =
      "Device is not capable of using the flashlight. Please test with flashlight.available()";
  private static final String NEEDS_TORCH_SERVICE =
      "requires the plugin variable ENABLE_TORCH_SERVICE=true (the foreground service is not in the manifest)";
  private static final String NEEDS_QS_TILE =
      "requires the plugin variable ENABLE_QS_TILE=true (the tile is not in the manifest)";
  private static final String NEEDS_SOS_TILE =
      "requires the plugin variables ENABLE_SOS_TILE=true and ENABLE_TORCH_SERVICE=true";

  /** setOngoingNotification call waiting for the POST_NOTIFICATIONS answer. */
  private CallbackContext pendingNotificationCallback;
  private boolean pendingNotificationEnabled;

  /** Last state reported by the TorchCallback (or by our own successful calls). */
  private volatile boolean torchOn;
  private volatile boolean torchAvailable = true;

  private CallbackContext stateCallbackContext;
  private CameraManager.TorchCallback torchCallback;
  private final Handler mainHandler = new Handler(Looper.getMainLooper());

  @Override
  public boolean execute(final String action, final JSONArray args, final CallbackContext callbackContext) throws JSONException {
    Log.d(TAG, "Plugin Called: " + action);

    if (ACTION_AVAILABLE.equals(action)) {
      callbackContext.success(isCapable() ? 1 : 0);
      return true;
    }

    if (ACTION_SWITCH_ON.equals(action)) {
      final JSONObject opts = args.optJSONObject(0);
      cordova.getThreadPool().execute(new Runnable() {
        public void run() {
          switchOn(opts, callbackContext);
        }
      });
      return true;
    }

    if (ACTION_SWITCH_OFF.equals(action)) {
      cordova.getThreadPool().execute(new Runnable() {
        public void run() {
          setTorch(false, callbackContext);
        }
      });
      return true;
    }

    if (ACTION_SWITCH_ON_WITH_STRENGTH.equals(action)) {
      final int level = args.optInt(0, -1);
      cordova.getThreadPool().execute(new Runnable() {
        public void run() {
          switchOnWithStrength(level, callbackContext);
        }
      });
      return true;
    }

    if (ACTION_GET_MAX_STRENGTH.equals(action)) {
      callbackContext.success(getMaxStrengthLevel());
      return true;
    }

    if (ACTION_GET_STRENGTH.equals(action)) {
      callbackContext.success(getStrengthLevel());
      return true;
    }

    if (ACTION_START_STATE_LISTENER.equals(action)) {
      startStateListener(callbackContext);
      return true;
    }

    if (ACTION_STOP_STATE_LISTENER.equals(action)) {
      stopStateListener();
      callbackContext.success();
      return true;
    }

    if (ACTION_START_PATTERN.equals(action)) {
      final JSONObject opts = args.optJSONObject(0);
      cordova.getThreadPool().execute(new Runnable() {
        public void run() {
          startPattern(opts, callbackContext);
        }
      });
      return true;
    }

    if (ACTION_STOP_PATTERN.equals(action)) {
      if (TorchForegroundService.isDeclared(context())) {
        try {
          TorchForegroundService.stopPattern(context());
        } catch (Exception e) {
          // startService() refused (the service was already stopping and the app is in the
          // background): there is no pattern left to stop.
          Log.w(TAG, "stopPattern", e);
        }
      }
      callbackContext.success();
      return true;
    }

    if (ACTION_SET_ONGOING_NOTIFICATION.equals(action)) {
      setOngoingNotification(args.optJSONObject(0), callbackContext);
      return true;
    }

    if (ACTION_REQUEST_ADD_TILE.equals(action)) {
      requestAddTile(args.optJSONObject(0), callbackContext);
      return true;
    }

    if (ACTION_GET_FEATURES.equals(action)) {
      callbackContext.success(features());
      return true;
    }

    callbackContext.error("flashlight." + action + " is not a supported function.");
    return false;
  }

  // ---------------------------------------------------------------- capability

  private Context context() {
    return cordova.getContext();
  }

  private CameraManager cameraManager() {
    return TorchCamera.manager(context());
  }

  private boolean isCapable() {
    return TorchCamera.isCapable(context());
  }

  /** The torch camera: prefer a back-facing camera with a flash unit, else any camera with one. */
  private String getTorchCameraId() {
    return TorchCamera.id(context());
  }

  // ---------------------------------------------------------------- on / off

  private void switchOn(JSONObject opts, CallbackContext cb) {
    // Optional {autoOffSeconds}: the off is scheduled in TorchForegroundService, so it fires even
    // if the WebView is gone. Needs the service; refuse before touching the torch otherwise.
    int autoOff = opts != null ? Math.max(0, opts.optInt("autoOffSeconds", 0)) : 0;
    if (autoOff > 0 && !TorchForegroundService.isDeclared(context())) {
      cb.error("autoOffSeconds " + NEEDS_TORCH_SERVICE);
      return;
    }
    // Optional {intensity: 0..1}: honoured on API 33+ hardware that supports dimming.
    if (opts != null && opts.has("intensity")) {
      double intensity = opts.optDouble("intensity", 1.0);
      int max = getMaxStrengthLevel();
      if (max > 1 && intensity > 0.0 && intensity < 1.0) {
        int level = (int) Math.max(1, Math.round(intensity * max));
        switchOnWithStrength(level, cb, autoOff);
        return;
      }
    }
    setTorch(true, cb, autoOff);
  }

  private void setTorch(boolean on, CallbackContext cb) {
    setTorch(on, cb, 0);
  }

  private void setTorch(boolean on, CallbackContext cb, int autoOffSeconds) {
    if (!isCapable()) {
      cb.error(NOT_CAPABLE);
      return;
    }
    // A native SOS/strobe pattern would undo this switch on its next step.
    TorchForegroundService.haltPatternForManualControl();
    try {
      cameraManager().setTorchMode(getTorchCameraId(), on);
      torchOn = on;
      if (on && !afterTorchOn(autoOffSeconds, cb)) {
        return;
      }
      if (!on) {
        // A halted pattern may have left the torch already off, and then no TorchCallback fires:
        // tell the service directly so it doesn't keep its notification for a dark torch.
        try {
          TorchForegroundService.onTorchOff(context());
        } catch (Exception e) {
          Log.w(TAG, "could not notify the torch service", e);
        }
      }
      cb.success();
    } catch (CameraAccessException e) {
      cb.error(describe(e));
    } catch (Exception e) {
      cb.error(e.getMessage() != null ? e.getMessage() : e.toString());
    }
  }

  private void switchOnWithStrength(int level, CallbackContext cb) {
    switchOnWithStrength(level, cb, 0);
  }

  private void switchOnWithStrength(int level, CallbackContext cb, int autoOffSeconds) {
    int max = getMaxStrengthLevel();
    if (max <= 1) {
      // No dimming on this device / OS: a plain switch-on is the only level there is.
      setTorch(true, cb, autoOffSeconds);
      return;
    }
    if (!isCapable()) {
      cb.error(NOT_CAPABLE);
      return;
    }
    int clamped = Math.max(1, Math.min(max, level));
    TorchForegroundService.haltPatternForManualControl();
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        cameraManager().turnOnTorchWithStrengthLevel(getTorchCameraId(), clamped);
        torchOn = true;
        if (!afterTorchOn(autoOffSeconds, cb)) {
          return;
        }
        cb.success(clamped);
      } else {
        setTorch(true, cb, autoOffSeconds);
      }
    } catch (CameraAccessException e) {
      cb.error(describe(e));
    } catch (Exception e) {
      cb.error(e.getMessage() != null ? e.getMessage() : e.toString());
    }
  }

  /**
   * The torch just went on through the plugin: hand it to the foreground service (if the app
   * enabled it) for the ongoing notification and the optional auto-off timer.
   *
   * @return false when an auto-off was requested but the service couldn't start - the torch is
   *     switched back off and cb has been answered with the error (no silent "on forever").
   */
  private boolean afterTorchOn(int autoOffSeconds, CallbackContext cb) {
    try {
      TorchForegroundService.onTorchOn(context(), autoOffSeconds);
      return true;
    } catch (Exception e) {
      Log.w(TAG, "could not start the torch service", e);
      if (autoOffSeconds <= 0) {
        return true; // the torch is on; only the notification is missing
      }
      try {
        cameraManager().setTorchMode(getTorchCameraId(), false);
        torchOn = false;
      } catch (Exception ignore) {
      }
      cb.error("could not start the auto-off service: " + e);
      return false;
    }
  }

  // ---------------------------------------------------------------- native patterns / service

  private void startPattern(JSONObject opts, CallbackContext cb) {
    if (!TorchForegroundService.isDeclared(context())) {
      cb.error("startPattern " + NEEDS_TORCH_SERVICE);
      return;
    }
    if (!isCapable()) {
      cb.error(NOT_CAPABLE);
      return;
    }
    String type = opts != null ? opts.optString("type", TorchForegroundService.PATTERN_SOS) : TorchForegroundService.PATTERN_SOS;
    if (!TorchForegroundService.PATTERN_SOS.equals(type) && !TorchForegroundService.PATTERN_STROBE.equals(type)) {
      cb.error("startPattern: unknown type '" + type + "' (expected 'sos' or 'strobe')");
      return;
    }
    double hz = opts != null ? opts.optDouble("hz", TorchForegroundService.DEFAULT_STROBE_HZ) : TorchForegroundService.DEFAULT_STROBE_HZ;
    if (Double.isNaN(hz) || hz <= 0) {
      hz = TorchForegroundService.DEFAULT_STROBE_HZ;
    }
    hz = Math.min(hz, TorchForegroundService.MAX_STROBE_HZ);
    try {
      TorchForegroundService.startPattern(context(), type, hz);
      JSONObject r = new JSONObject();
      r.put("type", type);
      if (TorchForegroundService.PATTERN_STROBE.equals(type)) {
        r.put("hz", hz);
      }
      cb.success(r);
    } catch (Exception e) {
      cb.error("could not start the pattern service: " + e);
    }
  }

  private void setOngoingNotification(JSONObject opts, CallbackContext cb) {
    Context ctx = context();
    if (!TorchForegroundService.isDeclared(ctx)) {
      cb.error("setOngoingNotification " + NEEDS_TORCH_SERVICE);
      return;
    }
    if (opts != null && opts.has("paused")) {
      // Pause / resume only: no saved setting or string is touched, and nothing is asked.
      TorchForegroundService.setNotificationPaused(ctx, opts.optBoolean("paused", false));
      answerNotification(cb, TorchForegroundService.isNotificationEnabled(ctx));
      return;
    }
    boolean enabled = opts == null || opts.optBoolean("enabled", true);
    TorchForegroundService.saveConfig(ctx, enabled,
        optString(opts, "title"), optString(opts, "offLabel"), optString(opts, "channelName"));

    if (enabled && Build.VERSION.SDK_INT >= 33 && !cordova.hasPermission(POST_NOTIFICATIONS)) {
      CallbackContext previous = pendingNotificationCallback;
      if (previous != null) {
        previous.error("superseded by a newer setOngoingNotification call");
      }
      pendingNotificationCallback = cb;
      pendingNotificationEnabled = enabled;
      cordova.requestPermission(this, REQ_POST_NOTIFICATIONS, POST_NOTIFICATIONS);
      return;
    }
    answerNotification(cb, enabled);
  }

  private void answerNotification(CallbackContext cb, boolean enabled) {
    String permission;
    if (Build.VERSION.SDK_INT < 33) {
      permission = "not-required";
    } else {
      permission = cordova.hasPermission(POST_NOTIFICATIONS) ? "granted" : "denied";
    }
    try {
      JSONObject r = new JSONObject();
      r.put("enabled", enabled);
      r.put("paused", TorchForegroundService.isNotificationPaused());
      r.put("permission", permission);
      cb.success(r);
    } catch (JSONException e) {
      cb.error(e.getMessage());
    }
  }

  /** cordova-android 10+ delivers here. */
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) throws JSONException {
    handlePermissionResult(requestCode);
  }

  /** Older cordova-android delivers here (kept for them; guarded against double delivery). */
  @Deprecated
  public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) throws JSONException {
    handlePermissionResult(requestCode);
  }

  private void handlePermissionResult(int requestCode) {
    if (requestCode != REQ_POST_NOTIFICATIONS) {
      return;
    }
    CallbackContext cb = pendingNotificationCallback;
    pendingNotificationCallback = null;
    if (cb != null) {
      answerNotification(cb, pendingNotificationEnabled);
    }
  }

  private void requestAddTile(JSONObject opts, CallbackContext cb) {
    Context ctx = context();
    boolean sos = opts != null && "sos".equals(opts.optString("tile", "torch"));
    Class<?> tile = sos ? SosTileService.class : TorchTileService.class;
    if (!TorchCamera.isServiceDeclared(ctx, tile)) {
      cb.error("requestAddTile " + (sos ? NEEDS_SOS_TILE : NEEDS_QS_TILE));
      return;
    }
    if (Build.VERSION.SDK_INT < 33) {
      cb.error("requestAddTile requires Android 13 (API 33); ask the user to add the tile from the Quick Settings editor");
      return;
    }
    String label = sos
        ? TorchCamera.string(ctx, "flashlight_sos_tile_label", "SOS")
        : TorchCamera.string(ctx, "flashlight_tile_label", "Flashlight");
    int icon = sos ? TorchCamera.res(ctx, "drawable", "flashlight_ic_sos") : 0;
    if (icon == 0) {
      icon = TorchCamera.torchIcon(ctx);
    }
    try {
      Api33.requestAddTile(ctx, new ComponentName(ctx, tile), label, icon, cb);
    } catch (Exception e) {
      cb.error("requestAddTile failed: " + e);
    }
  }

  /** API 33 calls, isolated so older runtimes never resolve these classes. */
  private static final class Api33 {
    static void requestAddTile(Context ctx, ComponentName cn, String label, int icon, final CallbackContext cb) {
      StatusBarManager sbm = ctx.getSystemService(StatusBarManager.class);
      if (sbm == null) {
        cb.error("requestAddTile: no status bar service");
        return;
      }
      // Resolves with StatusBarManager.TILE_ADD_REQUEST_RESULT_* / TILE_ADD_REQUEST_ERROR_* as is.
      sbm.requestAddTileService(cn, label, Icon.createWithResource(ctx, icon), ctx.getMainExecutor(),
          new java.util.function.Consumer<Integer>() {
            @Override
            public void accept(Integer result) {
              cb.success(result != null ? result : 0);
            }
          });
    }
  }

  private JSONObject features() {
    Context ctx = context();
    JSONObject f = new JSONObject();
    try {
      boolean qs = TorchCamera.isServiceDeclared(ctx, TorchTileService.class);
      boolean service = TorchForegroundService.isDeclared(ctx);
      f.put("qsTile", qs);
      f.put("sosTile", TorchCamera.isServiceDeclared(ctx, SosTileService.class));
      f.put("torchService", service);
      f.put("ongoingNotification", service && TorchForegroundService.isNotificationEnabled(ctx));
      f.put("canRequestAddTile", qs && Build.VERSION.SDK_INT >= 33);
      String pattern = TorchForegroundService.runningPattern();
      f.put("runningPattern", pattern != null ? pattern : JSONObject.NULL);
    } catch (JSONException e) {
      Log.w(TAG, "features", e);
    }
    return f;
  }

  private static String optString(JSONObject o, String key) {
    if (o == null || !o.has(key) || o.isNull(key)) {
      return null;
    }
    return o.optString(key, null);
  }

  // ---------------------------------------------------------------- strength

  private int getMaxStrengthLevel() {
    if (Build.VERSION.SDK_INT < 33 || !isCapable()) {
      return 1;
    }
    try {
      Integer max = cameraManager().getCameraCharacteristics(getTorchCameraId())
          .get(CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL);
      return (max != null && max > 1) ? max : 1;
    } catch (Exception e) {
      return 1;
    }
  }

  private int getStrengthLevel() {
    if (Build.VERSION.SDK_INT < 33 || getMaxStrengthLevel() <= 1) {
      return 1;
    }
    try {
      return cameraManager().getTorchStrengthLevel(getTorchCameraId());
    } catch (Exception e) {
      return 1;
    }
  }

  // ---------------------------------------------------------------- state listener

  private void startStateListener(CallbackContext cb) {
    // Replace a previous listener callback (e.g. after a page reload) - there is only one.
    stateCallbackContext = cb;

    if (!isCapable()) {
      torchAvailable = false;
      emitState(null);
      return;
    }

    if (torchCallback == null) {
      torchCallback = new CameraManager.TorchCallback() {
        @Override
        public void onTorchModeChanged(String cameraId, boolean enabled) {
          if (!cameraId.equals(getTorchCameraId())) {
            return;
          }
          torchOn = enabled;
          torchAvailable = true;
          emitState(null);
        }

        @Override
        public void onTorchModeUnavailable(String cameraId) {
          if (!cameraId.equals(getTorchCameraId())) {
            return;
          }
          // The camera is opened by someone else: the torch is off and can't be switched on.
          torchOn = false;
          torchAvailable = false;
          emitState(null);
        }

        @Override
        public void onTorchStrengthLevelChanged(String cameraId, int newStrengthLevel) {
          if (!cameraId.equals(getTorchCameraId())) {
            return;
          }
          emitState(newStrengthLevel);
        }
      };
      // The framework answers immediately with the current state, so JS gets an initial event.
      cameraManager().registerTorchCallback(torchCallback, mainHandler);
    } else {
      emitState(null);
    }
  }

  private void stopStateListener() {
    if (torchCallback != null) {
      try {
        cameraManager().unregisterTorchCallback(torchCallback);
      } catch (Exception ignore) {
      }
      torchCallback = null;
    }
    CallbackContext cb = stateCallbackContext;
    stateCallbackContext = null;
    if (cb != null) {
      // Release the persistent JS callback.
      PluginResult result = new PluginResult(PluginResult.Status.NO_RESULT);
      result.setKeepCallback(false);
      cb.sendPluginResult(result);
    }
  }

  private void emitState(Integer strengthLevel) {
    CallbackContext cb = stateCallbackContext;
    if (cb == null) {
      return;
    }
    try {
      JSONObject state = new JSONObject();
      state.put("isOn", torchOn);
      state.put("available", torchAvailable);
      state.put("strengthLevel", strengthLevel != null ? strengthLevel : (torchOn ? getStrengthLevel() : 0));
      state.put("maxStrengthLevel", getMaxStrengthLevel());
      PluginResult result = new PluginResult(PluginResult.Status.OK, state);
      result.setKeepCallback(true);
      cb.sendPluginResult(result);
    } catch (JSONException e) {
      Log.w(TAG, "Could not emit torch state", e);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  @Override
  public void onReset() {
    // The page reloaded: its listener callback is gone.
    stopStateListener();
  }

  @Override
  public void onDestroy() {
    stopStateListener();
  }

  private static String describe(CameraAccessException e) {
    String reason;
    switch (e.getReason()) {
      case CameraAccessException.CAMERA_IN_USE:
        reason = "camera in use";
        break;
      case CameraAccessException.MAX_CAMERAS_IN_USE:
        reason = "max cameras in use";
        break;
      case CameraAccessException.CAMERA_DISABLED:
        reason = "camera disabled by policy";
        break;
      case CameraAccessException.CAMERA_DISCONNECTED:
        reason = "camera disconnected";
        break;
      default:
        reason = "camera error";
    }
    return e.getMessage() != null ? reason + ": " + e.getMessage() : reason;
  }
}
