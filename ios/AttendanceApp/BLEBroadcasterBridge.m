#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(BLEBroadcasterModule, RCTEventEmitter)

RCT_EXTERN_METHOD(startBroadcasting:(NSString *)studentId
                  hmac:(NSString *)hmac
                  timestamp:(nonnull NSNumber *)timestamp)
RCT_EXTERN_METHOD(stopBroadcasting)
RCT_EXTERN_METHOD(startScanning)
RCT_EXTERN_METHOD(stopScanning)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
