#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
@interface SynthBridge : NSObject
@property(nonatomic, readonly) BOOL running;
@property(nonatomic, readonly) NSString *status;
@property(nonatomic, readonly) NSString *midiSources;
@property(nonatomic, readonly) float peak;
@property(nonatomic, readonly) uint32_t droppedEvents;
- (BOOL)start;
- (void)stop;
- (void)selectEngine:(NSInteger)engine;
- (void)setParameter:(NSInteger)parameter value:(float)value;
- (void)setMasterVolume:(float)value;
- (void)setVelocitySensitive:(BOOL)enabled;
- (void)setMonoMode:(BOOL)enabled;
- (void)sendStatus:(uint8_t)status data1:(uint8_t)data1 data2:(uint8_t)data2;
- (void)panic;
@end
NS_ASSUME_NONNULL_END
