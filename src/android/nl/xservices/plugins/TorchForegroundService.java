package nl.xservices.plugins;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.hardware.camera2.CameraManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.service.quicksettings.TileService;
import android.util.Log;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * "Flashlight is on" foreground service (opt-in: plugin variable ENABLE_TORCH_SERVICE).
 *
 * Why a foreground service: CameraService switches a torch off when the process that switched it
 * on dies. Holding a foreground service keeps the process - and so the torch, the auto-off timer
 * and a blink pattern - alive after the WebView/activity is gone, and gives the user an ongoing
 * notification with a "Turn off" action.
 *
 * FGS type: specialUse (subtype "torch_control"). Not "camera": that type is for apps that keep a
 * camera device open (it requires the CAMERA runtime permission on Android 14+), while
 * CameraManager.setTorchMode never opens the camera and needs no permission.
 *
 * Lifetime: started when the torch goes on through the plugin (or a tile), stopped when the torch
 * goes off from any source - observed with a CameraManager.TorchCallback - or by its own
 * "Turn off" action / auto-off timer. While a blink pattern runs, the pattern's own off-phases are
 * ignored.
 */
public class TorchForegroundService extends Service {

  static final String ACTION_TORCH_ON = "nl.xservices.plugins.flashlight.TORCH_ON";
  static final String ACTION_OFF = "nl.xservices.plugins.flashlight.OFF";
  static final String ACTION_START_PATTERN = "nl.xservices.plugins.flashlight.START_PATTERN";
  static final String ACTION_STOP_PATTERN = "nl.xservices.plugins.flashlight.STOP_PATTERN";
  static final String ACTION_REFRESH = "nl.xservices.plugins.flashlight.REFRESH";
  static final String ACTION_TORCH_OFF = "nl.xservices.plugins.flashlight.TORCH_OFF";

  static final String EXTRA_AUTO_OFF_SECONDS = "autoOffSeconds";
  static final String EXTRA_PATTERN = "pattern";
  static final String EXTRA_HZ = "hz";

  static final String PATTERN_SOS = "sos";
  static final String PATTERN_STROBE = "strobe";
  static final double MAX_STROBE_HZ = 20.0;
  static final double DEFAULT_STROBE_HZ = 10.0;

  private static final String TAG = TorchCamera.TAG;
  private static final String CHANNEL_ID = "flashlight_torch";
  private static final int NOTIFICATION_ID = 0x464C; // "FL"
  /** If the torch hasn't been seen on this long after a start request, there is nothing to hold. */
  private static final long START_WATCHDOG_MS = 3000;

  private static final String PREFS = "community_cordova_plugin_flashlight";
  private static final String PREF_ENABLED = "notification_enabled";
  private static final String PREF_TITLE = "notification_title";
  private static final String PREF_OFF_LABEL = "notification_off_label";
  private static final String PREF_CHANNEL_NAME = "notification_channel_name";

  // SOS in Morse at a 200 ms unit: dot 1, dash 3, symbol gap 1, letter gap 3, word gap 7.
  // Alternating on/off durations, starting with "on".
  private static final long[] SOS = {
      200, 200, 200, 200, 200, 600,
      600, 200, 600, 200, 600, 600,
      200, 200, 200, 200, 200, 1400
  };

  /** The running instance (same process as the plugin and the tiles). */
  private static volatile TorchForegroundService instance;
  /** Running pattern type, or null. Read by the SOS tile and getFeatures(). */
  private static volatile String runningPattern;

  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private CameraManager.TorchCallback torchCallback;
  private String cameraId;
  private boolean seenOn;
  private boolean inForeground;
  /** startId of the newest command; stopSelf(id) then never drops a start that is still queued. */
  private int lastStartId;
  private long autoOffAt; // elapsedRealtime, 0 = no timer

  private HandlerThread patternThread;
  private Handler patternHandler;
  /** Bumped on every pattern start/stop; a step from an older generation does nothing. */
  private volatile int patternGeneration;

  private final Runnable autoOff = new Runnable() {
    public void run() {
      Log.d(TAG, "auto-off timer fired");
      turnOffAndStop();
    }
  };

  private final Runnable startWatchdog = new Runnable() {
    public void run() {
      if (!seenOn && runningPattern == null) {
        Log.d(TAG, "torch not on after start request - stopping service");
        stopNow();
      }
    }
  };

  // ------------------------------------------------------------------ static API (plugin / tiles)

  static boolean isDeclared(Context ctx) {
    return TorchCamera.isServiceDeclared(ctx, TorchForegroundService.class);
  }

  static String runningPattern() {
    return runningPattern;
  }

  /**
   * setOngoingNotification({paused: true}): the app blinks the torch itself (a JS SOS / strobe) and
   * would otherwise start and stop the service on every blink. In memory only - never persisted,
   * never prompts - so a new process (or {paused: false}) is back to the saved setting.
   */
  private static volatile boolean notificationPaused = false;

  /** The saved setting (setOngoingNotification({enabled})), default true. Ignores a pause. */
  static boolean isNotificationEnabled(Context ctx) {
    return prefs(ctx).getBoolean(PREF_ENABLED, true);
  }

  /** Whether a plain "on" starts the service right now: enabled and not paused. */
  static boolean isNotificationActive(Context ctx) {
    return !notificationPaused && isNotificationEnabled(ctx);
  }

  static boolean isNotificationPaused() {
    return notificationPaused;
  }

  /** Pauses / resumes the notification without touching the saved setting or its strings. */
  static void setNotificationPaused(Context ctx, boolean paused) {
    notificationPaused = paused;
    refreshIfRunning(ctx);
  }

  static void saveConfig(Context ctx, boolean enabled, String title, String offLabel, String channelName) {
    SharedPreferences.Editor e = prefs(ctx).edit().putBoolean(PREF_ENABLED, enabled);
    putOrRemove(e, PREF_TITLE, title);
    putOrRemove(e, PREF_OFF_LABEL, offLabel);
    putOrRemove(e, PREF_CHANNEL_NAME, channelName);
    e.apply();
    refreshIfRunning(ctx);
  }

  private static void refreshIfRunning(Context ctx) {
    TorchForegroundService s = instance;
    if (s != null) {
      Intent i = new Intent(ctx, TorchForegroundService.class).setAction(ACTION_REFRESH);
      ctx.startService(i); // already running, so this is not a background start
    }
  }

  /**
   * The torch was switched on (plugin or tile). Starts the service when the notification is
   * enabled or an auto-off timer is requested; with autoOffSeconds 0 an existing timer is cleared.
   *
   * @return true when the service was started (or asked to start)
   */
  static boolean onTorchOn(Context ctx, int autoOffSeconds) {
    if (!isDeclared(ctx)) {
      return false;
    }
    if (autoOffSeconds <= 0 && !isNotificationActive(ctx) && instance == null) {
      return false;
    }
    Intent i = new Intent(ctx, TorchForegroundService.class)
        .setAction(ACTION_TORCH_ON)
        .putExtra(EXTRA_AUTO_OFF_SECONDS, Math.max(0, autoOffSeconds));
    startFgs(ctx, i);
    return true;
  }

  static void startPattern(Context ctx, String type, double hz) {
    Intent i = new Intent(ctx, TorchForegroundService.class)
        .setAction(ACTION_START_PATTERN)
        .putExtra(EXTRA_PATTERN, type)
        .putExtra(EXTRA_HZ, hz);
    startFgs(ctx, i);
  }

  /**
   * The plugin switched the torch off. Normally the TorchCallback sees that, but not when the torch
   * was already dark (a pattern halted in an off phase): then nothing changes and no callback fires.
   */
  static void onTorchOff(Context ctx) {
    if (instance == null) {
      return;
    }
    ctx.startService(new Intent(ctx, TorchForegroundService.class).setAction(ACTION_TORCH_OFF));
  }

  static void stopPattern(Context ctx) {
    if (instance == null) {
      return;
    }
    ctx.startService(new Intent(ctx, TorchForegroundService.class).setAction(ACTION_STOP_PATTERN));
  }

  /**
   * Halts a running pattern synchronously and leaves the torch as it is, so a direct plugin
   * switchOn/switchOff that follows isn't undone by the next pattern step. Call off the main thread.
   */
  static void haltPatternForManualControl() {
    TorchForegroundService s = instance;
    if (s == null || runningPattern == null) {
      return;
    }
    s.haltPattern(true);
  }

  private static void startFgs(Context ctx, Intent i) {
    if (Build.VERSION.SDK_INT >= 26) {
      ctx.startForegroundService(i);
    } else {
      ctx.startService(i);
    }
  }

  private static SharedPreferences prefs(Context ctx) {
    return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static void putOrRemove(SharedPreferences.Editor e, String key, String value) {
    if (value != null && !value.isEmpty()) {
      e.putString(key, value);
    } else {
      e.remove(key);
    }
  }

  // ------------------------------------------------------------------ lifecycle

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
    cameraId = TorchCamera.id(this);
    if (cameraId != null) {
      torchCallback = new CameraManager.TorchCallback() {
        @Override
        public void onTorchModeChanged(String id, boolean enabled) {
          if (!id.equals(cameraId)) {
            return;
          }
          if (enabled) {
            seenOn = true;
            return;
          }
          // Off from any source (the app, another app, the system tile): nothing left to hold -
          // unless it is one of our own pattern's off phases. Not before onStartCommand has called
          // startForeground(): stopping a startForegroundService() start before that crashes the
          // app (the start watchdog covers that case).
          if (inForeground && seenOn && runningPattern == null) {
            stopNow();
          }
        }

        @Override
        public void onTorchModeUnavailable(String id) {
          if (!id.equals(cameraId)) {
            return;
          }
          // Another app opened the camera: the torch is off and can't come back on.
          haltPattern(false);
          if (inForeground) {
            stopNow();
          }
        }
      };
      TorchCamera.manager(this).registerTorchCallback(torchCallback, mainHandler);
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    lastStartId = startId;
    String action = intent != null ? intent.getAction() : null;
    if (ACTION_OFF.equals(action)) {
      // The notification's "Turn off" action.
      turnOffAndStop();
      return START_NOT_STICKY;
    }
    boolean fgsStart = ACTION_TORCH_ON.equals(action) || ACTION_START_PATTERN.equals(action);
    if (cameraId == null) {
      if (fgsStart) {
        goForeground(); // startForegroundService() must be answered with startForeground()
      }
      stopNow();
      return START_NOT_STICKY;
    }
    if (ACTION_TORCH_ON.equals(action)) {
      haltPattern(true);
      int seconds = intent.getIntExtra(EXTRA_AUTO_OFF_SECONDS, 0);
      mainHandler.removeCallbacks(autoOff);
      autoOffAt = 0;
      if (seconds > 0) {
        autoOffAt = SystemClock.elapsedRealtime() + seconds * 1000L;
        mainHandler.postDelayed(autoOff, seconds * 1000L);
      }
      goForeground(); // always answer startForegroundService() first
      if (seconds <= 0 && !isNotificationActive(this)) {
        stopNow(); // a plain "on" with the notification disabled needs no service
        return START_NOT_STICKY;
      }
      if (!seenOn) {
        mainHandler.removeCallbacks(startWatchdog);
        mainHandler.postDelayed(startWatchdog, START_WATCHDOG_MS);
      }
    } else if (ACTION_START_PATTERN.equals(action)) {
      mainHandler.removeCallbacks(autoOff);
      autoOffAt = 0;
      String type = intent.getStringExtra(EXTRA_PATTERN);
      double hz = intent.getDoubleExtra(EXTRA_HZ, DEFAULT_STROBE_HZ);
      startPatternInternal(PATTERN_STROBE.equals(type) ? PATTERN_STROBE : PATTERN_SOS, hz);
      goForeground();
    } else if (ACTION_STOP_PATTERN.equals(action)) {
      // Sent with startService(), so no startForeground() is owed - and calling it here, from the
      // background after the service already left the foreground, would throw on Android 12+.
      if (runningPattern != null) {
        turnOffAndStop();
      } else if (!inForeground || !seenOn) {
        stopNow(); // nothing running and no plain "on" to hold
      }
    } else if (ACTION_TORCH_OFF.equals(action)) {
      // startService() too. The plugin switched the torch off; a pattern started since then keeps us.
      if (runningPattern == null) {
        stopNow();
      }
    } else if (ACTION_REFRESH.equals(action)) {
      if (!inForeground || (runningPattern == null && autoOffAt == 0 && !isNotificationActive(this))) {
        // Notification switched off while only holding a plain "on": nothing else needs us.
        stopNow();
      } else {
        goForeground(); // re-post with the new strings
      }
    } else {
      // Restarted without an intent (we are START_NOT_STICKY, so this shouldn't happen). Only the
      // startForegroundService() actions above owe a startForeground().
      stopNow();
    }
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onDestroy() {
    mainHandler.removeCallbacksAndMessages(null);
    haltPattern(false);
    if (torchCallback != null) {
      try {
        TorchCamera.manager(this).unregisterTorchCallback(torchCallback);
      } catch (Exception ignore) {
      }
      torchCallback = null;
    }
    if (patternThread != null) {
      patternThread.quitSafely();
      patternThread = null;
      patternHandler = null;
    }
    if (instance == this) {
      instance = null;
    }
    super.onDestroy();
  }

  // ------------------------------------------------------------------ off / stop

  private void turnOffAndStop() {
    haltPattern(false);
    try {
      TorchCamera.setTorch(this, false);
    } catch (Exception e) {
      Log.w(TAG, "could not switch the torch off", e);
    }
    stopNow();
  }

  private void stopNow() {
    mainHandler.removeCallbacks(autoOff);
    mainHandler.removeCallbacks(startWatchdog);
    autoOffAt = 0;
    if (inForeground) {
      stopForeground(Service.STOP_FOREGROUND_REMOVE);
      inForeground = false;
    }
    // Only up to the newest command seen: a startForegroundService() still queued (e.g. a quick
    // second tap) must reach onStartCommand, or the system crashes the app for a missed startForeground.
    stopSelf(lastStartId);
  }

  // ------------------------------------------------------------------ patterns

  private Handler patternHandler() {
    if (patternHandler == null) {
      patternThread = new HandlerThread("FlashlightPattern");
      patternThread.start();
      patternHandler = new Handler(patternThread.getLooper());
    }
    return patternHandler;
  }

  /** synchronized with haltPattern: the plugin's thread pool and the main thread both get here. */
  private synchronized void startPatternInternal(String type, double hz) {
    final long[] steps;
    if (PATTERN_STROBE.equals(type)) {
      double f = (hz > 0 && !Double.isNaN(hz)) ? Math.min(hz, MAX_STROBE_HZ) : DEFAULT_STROBE_HZ;
      long half = Math.max(1L, Math.round(500.0 / f));
      steps = new long[]{half, half};
    } else {
      steps = SOS;
    }
    final Handler h = patternHandler();
    final int generation = ++patternGeneration;
    h.removeCallbacksAndMessages(null);
    runningPattern = type;
    seenOn = true; // the pattern owns the torch now; its off phases must not stop us
    refreshSosTile();
    h.post(new Runnable() {
      int index = 0;

      public void run() {
        if (generation != patternGeneration) {
          return;
        }
        boolean on = index % 2 == 0;
        try {
          TorchCamera.setTorch(TorchForegroundService.this, on);
        } catch (Exception e) {
          Log.w(TAG, "pattern step failed - stopping", e);
          mainHandler.post(new Runnable() {
            public void run() {
              turnOffAndStop();
            }
          });
          return;
        }
        long delay = steps[index];
        index = (index + 1) % steps.length;
        h.postDelayed(this, delay);
      }
    });
  }

  /**
   * Stops the pattern. On the pattern thread's own queue, so no step can run after this returns.
   *
   * @param keepTorch leave the torch as is (a manual switch follows) instead of switching it off
   */
  private synchronized void haltPattern(final boolean keepTorch) {
    if (runningPattern == null) {
      return;
    }
    patternGeneration++;
    runningPattern = null;
    final Handler h = patternHandler;
    if (h != null) {
      h.removeCallbacksAndMessages(null);
      final CountDownLatch done = new CountDownLatch(1);
      h.post(new Runnable() {
        public void run() {
          if (!keepTorch) {
            try {
              TorchCamera.setTorch(TorchForegroundService.this, false);
            } catch (Exception ignore) {
            }
          }
          done.countDown();
        }
      });
      if (Looper.myLooper() != h.getLooper()) {
        try {
          done.await(500, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
      }
    }
    refreshSosTile();
  }

  private void refreshSosTile() {
    if (!TorchCamera.isServiceDeclared(this, SosTileService.class)) {
      return;
    }
    SosTileService.refresh();
    try {
      TileService.requestListeningState(this, new ComponentName(this, SosTileService.class));
    } catch (Exception ignore) {
      // Not added to the panel, or the system refuses: the tile renders on its next listen.
    }
  }

  // ------------------------------------------------------------------ notification

  private void goForeground() {
    Notification n = buildNotification();
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
    } else {
      startForeground(NOTIFICATION_ID, n);
    }
    inForeground = true;
  }

  private Notification buildNotification() {
    SharedPreferences p = prefs(this);
    String channelName = p.getString(PREF_CHANNEL_NAME,
        TorchCamera.string(this, "flashlight_notification_channel", "Flashlight"));
    String title = p.getString(PREF_TITLE,
        TorchCamera.string(this, "flashlight_notification_title", "Flashlight is on"));
    String offLabel = p.getString(PREF_OFF_LABEL,
        TorchCamera.string(this, "flashlight_notification_off", "Turn off"));

    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel ch = new NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW);
      ch.setSound(null, null);
      ch.enableVibration(false);
      ch.setShowBadge(false);
      NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
      if (nm != null) {
        nm.createNotificationChannel(ch); // also renames an existing channel
      }
      b = new Notification.Builder(this, CHANNEL_ID);
    } else {
      b = legacyBuilder();
    }

    int icon = TorchCamera.torchIcon(this);
    b.setSmallIcon(icon)
        .setContentTitle(title)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        .setVisibility(Notification.VISIBILITY_PUBLIC);

    String pattern = runningPattern;
    if (pattern != null) {
      b.setContentText(PATTERN_STROBE.equals(pattern) ? "Strobe" : "SOS");
    }
    if (autoOffAt > 0) {
      long remaining = Math.max(0, autoOffAt - SystemClock.elapsedRealtime());
      b.setWhen(System.currentTimeMillis() + remaining)
          .setShowWhen(true)
          .setUsesChronometer(true)
          .setChronometerCountDown(true);
    } else {
      b.setShowWhen(false);
    }
    if (Build.VERSION.SDK_INT >= 31) {
      b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
    }

    int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    Intent off = new Intent(this, TorchForegroundService.class).setAction(ACTION_OFF);
    PendingIntent offPi = PendingIntent.getService(this, 1, off, piFlags);
    b.addAction(new Notification.Action.Builder(Icon.createWithResource(this, icon), offLabel, offPi).build());

    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
    if (launch != null) {
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
      b.setContentIntent(PendingIntent.getActivity(this, 2, launch, piFlags));
    }
    return b.build();
  }

  @SuppressWarnings("deprecation")
  private Notification.Builder legacyBuilder() {
    return new Notification.Builder(this)
        .setPriority(Notification.PRIORITY_LOW)
        .setSound(null)
        .setVibrate(null);
  }
}
