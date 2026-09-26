package nl.xservices.plugins;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.Build;
import android.util.Log;

/**
 * Torch helpers shared by the Cordova plugin, the Quick Settings tiles and the foreground service.
 *
 * The camera-id selection is the plugin's: prefer a back-facing camera with a flash unit, else any
 * camera with one. A successful enumeration is cached for the process; a failed one is retried.
 */
final class TorchCamera {

  static final String TAG = "Flashlight";

  private static final Object LOCK = new Object();
  private static String cameraId;
  private static boolean resolved;

  private TorchCamera() {
  }

  static CameraManager manager(Context ctx) {
    return (CameraManager) ctx.getApplicationContext().getSystemService(Context.CAMERA_SERVICE);
  }

  /** The torch camera id, or null when the device has no usable flash unit. */
  static String id(Context ctx) {
    synchronized (LOCK) {
      if (resolved) {
        return cameraId;
      }
      String found = null;
      String fallback = null;
      try {
        CameraManager cm = manager(ctx);
        for (String id : cm.getCameraIdList()) {
          CameraCharacteristics c = cm.getCameraCharacteristics(id);
          if (!Boolean.TRUE.equals(c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE))) {
            continue;
          }
          Integer facing = c.get(CameraCharacteristics.LENS_FACING);
          if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
            found = id;
            break;
          }
          if (fallback == null) {
            fallback = id;
          }
        }
        cameraId = found != null ? found : fallback;
        resolved = true;
      } catch (Exception e) {
        // Leave unresolved so a later call can retry (e.g. camera service not ready yet).
        Log.w(TAG, "Could not enumerate cameras", e);
        return null;
      }
      return cameraId;
    }
  }

  /** Flash hardware present and a torch camera found (Android 6+). */
  static boolean isCapable(Context ctx) {
    if (Build.VERSION.SDK_INT < 23) {
      return false;
    }
    if (!ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) {
      return false;
    }
    return id(ctx) != null;
  }

  /** setTorchMode on the torch camera. Throws when there is none or the camera refuses. */
  static void setTorch(Context ctx, boolean on) throws CameraAccessException {
    String id = id(ctx);
    if (id == null) {
      throw new IllegalStateException("no flash unit");
    }
    manager(ctx).setTorchMode(id, on);
  }

  /**
   * Whether this app's manifest declares the service. The tile and foreground-service entries are
   * opt-in (plugin variables), so this is the runtime truth of what the app was built with.
   */
  static boolean isServiceDeclared(Context ctx, Class<?> cls) {
    ComponentName cn = new ComponentName(ctx, cls);
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        ctx.getPackageManager().getServiceInfo(cn, PackageManager.ComponentInfoFlags.of(0));
      } else {
        getServiceInfoLegacy(ctx, cn);
      }
      return true;
    } catch (PackageManager.NameNotFoundException e) {
      return false;
    }
  }

  @SuppressWarnings("deprecation")
  private static void getServiceInfoLegacy(Context ctx, ComponentName cn) throws PackageManager.NameNotFoundException {
    ctx.getPackageManager().getServiceInfo(cn, 0);
  }

  /** A resource of the host app by name (the plugin can't reference the app's R class). */
  static int res(Context ctx, String type, String name) {
    return ctx.getResources().getIdentifier(name, type, ctx.getPackageName());
  }

  static String string(Context ctx, String name, String fallback) {
    int id = res(ctx, "string", name);
    if (id == 0) {
      return fallback;
    }
    try {
      return ctx.getString(id);
    } catch (Exception e) {
      return fallback;
    }
  }

  /** The torch icon, or the app icon if the drawable was stripped. */
  static int torchIcon(Context ctx) {
    int id = res(ctx, "drawable", "flashlight_ic_torch");
    return id != 0 ? id : ctx.getApplicationInfo().icon;
  }
}
