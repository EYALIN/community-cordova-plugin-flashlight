package nl.xservices.plugins;

import android.graphics.drawable.Icon;
import android.os.Handler;
import android.os.Looper;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import android.util.Log;

/**
 * Quick Settings "SOS" tile (opt-in: plugin variable ENABLE_SOS_TILE, which also needs
 * ENABLE_TORCH_SERVICE). A tap starts the native SOS pattern inside TorchForegroundService; a
 * second tap stops it. Without the service in the manifest the tile is STATE_UNAVAILABLE.
 */
public class SosTileService extends TileService {

  private static final String TAG = TorchCamera.TAG;
  private static final Handler MAIN = new Handler(Looper.getMainLooper());

  /** The instance whose tile is currently visible, if any. */
  private static volatile SosTileService listening;

  /** Called by the service when a pattern starts or stops. */
  static void refresh() {
    final SosTileService s = listening;
    if (s != null) {
      MAIN.post(new Runnable() {
        public void run() {
          s.render();
        }
      });
    }
  }

  @Override
  public void onStartListening() {
    super.onStartListening();
    listening = this;
    render();
  }

  @Override
  public void onStopListening() {
    if (listening == this) {
      listening = null;
    }
    super.onStopListening();
  }

  @Override
  public void onClick() {
    super.onClick();
    if (!usable()) {
      render();
      return;
    }
    try {
      if (TorchForegroundService.PATTERN_SOS.equals(TorchForegroundService.runningPattern())) {
        TorchForegroundService.stopPattern(this);
      } else {
        TorchForegroundService.startPattern(this, TorchForegroundService.PATTERN_SOS, 0);
      }
    } catch (Exception e) {
      // e.g. ForegroundServiceStartNotAllowedException.
      Log.w(TAG, "SOS tile: could not start/stop the pattern", e);
    }
    render();
  }

  private boolean usable() {
    return TorchCamera.isCapable(this) && TorchForegroundService.isDeclared(this);
  }

  private void render() {
    Tile tile = getQsTile();
    if (tile == null) {
      return;
    }
    tile.setLabel(TorchCamera.string(this, "flashlight_sos_tile_label", "SOS"));
    int icon = TorchCamera.res(this, "drawable", "flashlight_ic_sos");
    tile.setIcon(Icon.createWithResource(this, icon != 0 ? icon : TorchCamera.torchIcon(this)));
    if (!usable()) {
      tile.setState(Tile.STATE_UNAVAILABLE);
    } else {
      boolean sos = TorchForegroundService.PATTERN_SOS.equals(TorchForegroundService.runningPattern());
      tile.setState(sos ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
    }
    tile.updateTile();
  }
}
