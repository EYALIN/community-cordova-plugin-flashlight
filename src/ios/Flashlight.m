#import "Flashlight.h"
#import <AVFoundation/AVFoundation.h>
#import <Cordova/CDVPlugin.h>

// iOS drives the torch with a continuous level (0.0 - 1.0]. The JS API exposes
// integer strength levels on every platform, so iOS maps that range onto
// 1..FLASHLIGHT_IOS_MAX_LEVELS.
static const NSInteger FLASHLIGHT_IOS_MAX_LEVELS = 100;
static NSString *const NOT_CAPABLE = @"Device is not capable of using the flashlight. Please test with flashlight.available()";
static void *FlashlightKVOContext = &FlashlightKVOContext;

@interface Flashlight ()
@property (nonatomic, copy) NSString *stateCallbackId;
@property (nonatomic, strong) AVCaptureDevice *observedDevice;
@end

@implementation Flashlight

#pragma mark - helpers

- (AVCaptureDevice *)torchDevice {
    AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    if (device != nil && [device hasTorch] && [device isTorchModeSupported:AVCaptureTorchModeOn]) {
        return device;
    }
    return nil;
}

- (BOOL)deviceHasFlashlight {
    return [self torchDevice] != nil;
}

- (void)sendError:(NSString *)message callbackId:(NSString *)callbackId {
    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_ERROR messageAsString:message];
    [self.commandDelegate sendPluginResult:result callbackId:callbackId];
}

- (void)sendOk:(NSString *)callbackId {
    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK];
    [self.commandDelegate sendPluginResult:result callbackId:callbackId];
}

/// Switches the torch on at `level` (0.0 - 1.0]. Returns nil on success, otherwise an error message.
- (NSString *)turnOnAtLevel:(float)level {
    AVCaptureDevice *device = [self torchDevice];
    if (device == nil) {
        return NOT_CAPABLE;
    }
    NSError *error = nil;
    if (![device lockForConfiguration:&error]) {
        return error.localizedDescription ?: @"Could not lock the camera for configuration";
    }
    // 1.0 means "as bright as currently allowed" - the thermal state may cap the real maximum,
    // and asking for more than that fails.
    float value = (level >= 1.0f || level <= 0.0f) ? AVCaptureMaxAvailableTorchLevel : level;
    BOOL ok = [device setTorchModeOnWithLevel:value error:&error];
    if (!ok && value != AVCaptureMaxAvailableTorchLevel) {
        error = nil;
        ok = [device setTorchModeOnWithLevel:AVCaptureMaxAvailableTorchLevel error:&error];
    }
    [device unlockForConfiguration];
    if (!ok) {
        return error.localizedDescription ?: @"Could not switch the torch on";
    }
    return nil;
}

#pragma mark - actions

- (void)available:(CDVInvokedUrlCommand*)command {
    CDVPluginResult* pluginResult = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsBool:[self deviceHasFlashlight]];
    [self.commandDelegate sendPluginResult:pluginResult callbackId:command.callbackId];
}

- (void)switchOn:(CDVInvokedUrlCommand*)command {
    float value = 1.0f;
    if (command.arguments.count > 0) {
        id options = command.arguments[0];
        if ([options isKindOfClass:[NSDictionary class]]) {
            id intensity = options[@"intensity"];
            if ([intensity isKindOfClass:[NSNumber class]]) {
                float requestedValue = [intensity floatValue];
                if (requestedValue > 0.0f && requestedValue < 1.0f) {
                    value = requestedValue;
                }
            }
        }
    }
    NSString *errorMessage = [self turnOnAtLevel:value];
    if (errorMessage != nil) {
        [self sendError:errorMessage callbackId:command.callbackId];
    } else {
        [self sendOk:command.callbackId];
    }
}

- (void)switchOnWithStrength:(CDVInvokedUrlCommand*)command {
    NSInteger level = FLASHLIGHT_IOS_MAX_LEVELS;
    if (command.arguments.count > 0 && [command.arguments[0] isKindOfClass:[NSNumber class]]) {
        level = [command.arguments[0] integerValue];
    }
    level = MAX(1, MIN(FLASHLIGHT_IOS_MAX_LEVELS, level));
    NSString *errorMessage = [self turnOnAtLevel:(float)level / (float)FLASHLIGHT_IOS_MAX_LEVELS];
    if (errorMessage != nil) {
        [self sendError:errorMessage callbackId:command.callbackId];
    } else {
        CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsNSInteger:level];
        [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
    }
}

- (void)switchOff:(CDVInvokedUrlCommand*)command {
    AVCaptureDevice *device = [self torchDevice];
    if (device == nil) {
        [self sendError:NOT_CAPABLE callbackId:command.callbackId];
        return;
    }
    NSError *error = nil;
    if (![device lockForConfiguration:&error]) {
        [self sendError:(error.localizedDescription ?: @"Could not lock the camera for configuration") callbackId:command.callbackId];
        return;
    }
    [device setTorchMode:AVCaptureTorchModeOff];
    [device unlockForConfiguration];
    [self sendOk:command.callbackId];
}

- (void)getMaxStrengthLevel:(CDVInvokedUrlCommand*)command {
    NSInteger max = [self deviceHasFlashlight] ? FLASHLIGHT_IOS_MAX_LEVELS : 1;
    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsNSInteger:max];
    [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
}

- (NSInteger)currentStrengthLevel {
    AVCaptureDevice *device = [self torchDevice];
    if (device == nil) {
        return 1;
    }
    if (!device.isTorchActive) {
        return 0;
    }
    NSInteger level = (NSInteger)lroundf(device.torchLevel * (float)FLASHLIGHT_IOS_MAX_LEVELS);
    return MAX(1, MIN(FLASHLIGHT_IOS_MAX_LEVELS, level));
}

- (void)getStrengthLevel:(CDVInvokedUrlCommand*)command {
    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsNSInteger:[self currentStrengthLevel]];
    [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
}

#pragma mark - state listener (KVO on torchActive / torchAvailable / torchLevel)

- (void)startStateListener:(CDVInvokedUrlCommand*)command {
    // One persistent JS callback; a new registration replaces the previous one.
    self.stateCallbackId = command.callbackId;

    AVCaptureDevice *device = [self torchDevice];
    if (device == nil) {
        [self emitState];
        return;
    }
    if (self.observedDevice == nil) {
        self.observedDevice = device;
        NSKeyValueObservingOptions opts = NSKeyValueObservingOptionNew;
        [device addObserver:self forKeyPath:@"torchActive" options:opts context:FlashlightKVOContext];
        [device addObserver:self forKeyPath:@"torchAvailable" options:opts context:FlashlightKVOContext];
        [device addObserver:self forKeyPath:@"torchLevel" options:opts context:FlashlightKVOContext];
    }
    // Initial state.
    [self emitState];
}

- (void)stopStateListener:(CDVInvokedUrlCommand*)command {
    [self removeStateListener];
    [self sendOk:command.callbackId];
}

- (void)removeStateListener {
    if (self.observedDevice != nil) {
        @try {
            [self.observedDevice removeObserver:self forKeyPath:@"torchActive" context:FlashlightKVOContext];
            [self.observedDevice removeObserver:self forKeyPath:@"torchAvailable" context:FlashlightKVOContext];
            [self.observedDevice removeObserver:self forKeyPath:@"torchLevel" context:FlashlightKVOContext];
        } @catch (NSException *ignored) {
        }
        self.observedDevice = nil;
    }
    NSString *callbackId = self.stateCallbackId;
    self.stateCallbackId = nil;
    if (callbackId != nil) {
        // Release the persistent JS callback.
        CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_NO_RESULT];
        [result setKeepCallbackAsBool:NO];
        [self.commandDelegate sendPluginResult:result callbackId:callbackId];
    }
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey,id> *)change
                       context:(void *)context {
    if (context != FlashlightKVOContext) {
        [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
        return;
    }
    // KVO arrives on whatever thread changed the device; stateCallbackId is read / cleared on the
    // main thread (plugin methods, onReset, dispose), so emit from there.
    if ([NSThread isMainThread]) {
        [self emitState];
    } else {
        __weak Flashlight *weakSelf = self;
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf emitState];
        });
    }
}

- (void)emitState {
    NSString *callbackId = self.stateCallbackId;
    if (callbackId == nil) {
        return;
    }
    AVCaptureDevice *device = [self torchDevice];
    BOOL isOn = device != nil && device.isTorchActive;
    BOOL available = device != nil && device.isTorchAvailable;
    NSDictionary *state = @{
        @"isOn": @(isOn),
        @"available": @(available),
        @"strengthLevel": @(isOn ? [self currentStrengthLevel] : 0),
        @"maxStrengthLevel": @(device != nil ? FLASHLIGHT_IOS_MAX_LEVELS : 1)
    };
    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsDictionary:state];
    [result setKeepCallbackAsBool:YES];
    [self.commandDelegate sendPluginResult:result callbackId:callbackId];
}

#pragma mark - lifecycle

- (void)onReset {
    // The page reloaded: its listener callback is gone.
    [self removeStateListener];
}

- (void)dispose {
    [self removeStateListener];
    [super dispose];
}

@end
