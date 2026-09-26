#import <Cordova/CDVPlugin.h>

@interface Flashlight : CDVPlugin

- (void)available:(CDVInvokedUrlCommand*)command;
- (void)switchOn:(CDVInvokedUrlCommand*)command;
- (void)switchOff:(CDVInvokedUrlCommand*)command;
- (void)switchOnWithStrength:(CDVInvokedUrlCommand*)command;
- (void)getMaxStrengthLevel:(CDVInvokedUrlCommand*)command;
- (void)getStrengthLevel:(CDVInvokedUrlCommand*)command;
- (void)startStateListener:(CDVInvokedUrlCommand*)command;
- (void)stopStateListener:(CDVInvokedUrlCommand*)command;

@end
