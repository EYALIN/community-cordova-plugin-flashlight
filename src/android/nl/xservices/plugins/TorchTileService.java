package nl.xservices.plugins;

import android.graphics.drawable.Icon;
import android.hardware.camera2.CameraManager;
import android.os.Handler;
import android.os.Looper;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import android.util.Log;

/**
 * Quick Settings "Flashlight" tile (opt-in: plugin variable ENABLE_QS_TILE, API 24+).
 *
 * The tile state follows a CameraManager.TorchCallback registered while the panel is open
 * (onStartListening / onStopListening), so it is right whoever switched the torch. A tap toggles
 * the torch with setTorchMode on the plugin's torch camera. Tile.STATE_UNAVAILABLE when there is
 * no flash unit or another app holds the camera.
 */
public class TorchTileService extends TileService {

  private static final String TAG = TorchCamera.TAG;

  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private CameraManager.TorchCallback torchCallback;
  private String cameraId;
  private boolean torchOn;
  private boolean torchAvailable;

  @Override
  public void onStartListening() {
    super.onStartListening();
    cameraId = TorchCamera.isCapable(this) ? TorchCamera.id(this) : null;
    torchAvailable = cameraId != null;
    if (cameraId != null && torchCallback == null) {
      torchCallback = new CameraManager.TorchCallback() {
        @Override
        public void onTorchModeChanged(String id, boolean enabled) {
          if (!id.equals(cameraId)) {
            return;
          }
          torchOn = enabled;
          torchAvailable = true;
          render();
        }

        @Override
        public void onTorchModeUnavailable(String id) {
          if (!id.equals(cameraId)) {
            return;
          }
          torchOn = false;
          torchAvailable = false;
          render();
        }
      };
      try {
        // The framework answers right away with the current state.
        TorchCamera.manager(this).registerTorchCallback(torchCallback, mainHandler);
      } catch (Exception e) {
        Log.w(TAG, "tile: could not register the torch callback", e);
        torchCallback = null;
      }
    }
    render();
  }

  @Override
  public void onStopListening() {
    if (torchCallback != null) {
      try {
        TorchCamera.manager(this).unregisterTorchCallback(torchCallback);
      } catch (Exception ignore) {
      }
      torchCallback = null;
    }
    super.onStopListening();
  }

  @Override
  public void onClick() {
    super.onClick();
    if (cameraId == null || !torchAvailable) {
      render();
      return;
    }
    boolean target = !torchOn;
    // A running SOS/strobe pattern would undo the switch on its next step.
    TorchForegroundService.haltPatternForManualControl();
    try {
      TorchCamera.setTorch(this, target);
      torchOn = target;
    } catch (Exception e) {
      Log.w(TAG, "tile: could not switch the torch", e);
    }
    render();
    if (target && torchOn) {
      try {
        // Hold the process (and so the torch) with the ongoing notification, if the app has it.
        TorchForegroundService.onTorchOn(this, 0);
      } catch (Exception e) {
        // e.g. ForegroundServiceStartNotAllowedException: the torch is on, just no notification.
        Log.w(TAG, "tile: could not start the torch service", e);
      }
    }
  }

  private void render() {
    Tile tile = getQsTile();
    if (tile == null) {
      return;
    }
    tile.setLabel(TorchCamera.string(this, "flashlight_tile_label", "Flashlight"));
    tile.setIcon(Icon.createWithResource(this, TorchCamera.torchIcon(this)));
    if (cameraId == null || !torchAvailable) {
      tile.setState(Tile.STATE_UNAVAILABLE);
    } else {
      tile.setState(torchOn ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
    }
    tile.updateTile();
  }
}
