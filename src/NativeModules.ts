import { NativeModules, NativeEventEmitter } from 'react-native';

const { BLEBroadcasterModule } = NativeModules;

export const BLEBroadcaster = {
  startBroadcasting: async (studentId: string, pin: string): Promise<void> => {
    return BLEBroadcasterModule.startBroadcasting(studentId, pin);
  },
  stopBroadcasting: async (): Promise<void> => {
    return BLEBroadcasterModule.stopBroadcasting();
  },
  startScanning: async (): Promise<void> => {
    return BLEBroadcasterModule.startScanning();
  },
  stopScanning: async (): Promise<void> => {
    return BLEBroadcasterModule.stopScanning();
  }
};

export const bleEmitter = new NativeEventEmitter(BLEBroadcasterModule);
