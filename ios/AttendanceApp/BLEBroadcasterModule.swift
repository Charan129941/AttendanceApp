import Foundation
import CoreBluetooth
import React

@objc(BLEBroadcasterModule)
class BLEBroadcasterModule: RCTEventEmitter, CBPeripheralManagerDelegate, CBCentralManagerDelegate {

    private var peripheralManager: CBPeripheralManager!
    private var centralManager: CBCentralManager!
    private var isAdvertising = false
    private var isScanning = false
    
    // BLE constants (must match Android)
    private let COMPANY_ID: UInt16 = 0xFFFF
    private let PAYLOAD_SIZE = 12

    override init() {
        super.init()
        peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
        centralManager = CBCentralManager(delegate: self, queue: nil)
    }

    override static func requiresMainQueueSetup() -> Bool {
        return true
    }

    override func supportedEvents() -> [String] {
        return ["onAttendanceReceived"]
    }

    // MARK: - Broadcasting
    
    @objc func startBroadcasting(_ studentId: String, pin: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        if isAdvertising {
            reject("ERR_ALREADY_ADVERTISING", "BLE advertising is already active", nil)
            return
        }

        guard peripheralManager.state == .poweredOn else {
            reject("ERR_BLUETOOTH_OFF", "Bluetooth is not powered on or authorized", nil)
            return
        }

        guard let studentIdLong = UInt64(studentId), let pinInt = UInt32(pin) else {
            reject("ERR_INVALID_PAYLOAD", "studentId and pin must be valid numbers", nil)
            return
        }

        // Build 12-byte payload: [StudentID 8 bytes][PIN 4 bytes] (Big Endian)
        var payload = Data(capacity: PAYLOAD_SIZE)
        var studentIdBigEndian = studentIdLong.bigEndian
        var pinBigEndian = pinInt.bigEndian
        
        payload.append(withUnsafeBytes(of: &studentIdBigEndian) { Data($0) })
        payload.append(withUnsafeBytes(of: &pinBigEndian) { Data($0) })
        
        // Android scans for Manufacturer Data.
        // However, iOS ignores CBAdvertisementDataManufacturerDataKey when acting as a peripheral.
        // iOS CAN broadcast CBAdvertisementDataServiceUUIDsKey.
        // We will broadcast our payload inside a 128-bit CBUUID.
        var uuidData = Data(count: 4) // 4 padding bytes
        uuidData.append(payload)
        let customUUID = CBUUID(data: uuidData)
        
        let advData: [String: Any] = [
            CBAdvertisementDataServiceUUIDsKey: [customUUID]
        ]

        peripheralManager.startAdvertising(advData)
        isAdvertising = true
        resolve(nil)
    }

    @objc func stopBroadcasting(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        if isAdvertising {
            peripheralManager.stopAdvertising()
            isAdvertising = false
        }
        resolve(nil)
    }

    // MARK: - Scanning
    
    @objc func startScanning(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        if isScanning {
            reject("ERR_ALREADY_SCANNING", "BLE scanning is already active", nil)
            return
        }

        guard centralManager.state == .poweredOn else {
            reject("ERR_BLUETOOTH_OFF", "Bluetooth is not powered on or authorized", nil)
            return
        }

        centralManager.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        isScanning = true
        resolve(nil)
    }

    @objc func stopScanning(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        if isScanning {
            centralManager.stopScan()
            isScanning = false
        }
        resolve(nil)
    }

    // MARK: - CBCentralManagerDelegate
    
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        // Handle state changes if needed
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String : Any], rssi RSSI: NSNumber) {
        // 1. Android broadcasts using Manufacturer Data (0xFFFF)
        if let manufacturerData = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data {
            if manufacturerData.count >= 14 {
                let companyIdBytes = manufacturerData.subdata(in: 0..<2)
                let companyId = companyIdBytes.withUnsafeBytes { $0.loadUnaligned(as: UInt16.self) }
                
                if companyId == COMPANY_ID { // 0xFFFF
                    let payload = manufacturerData.subdata(in: 2..<14)
                    let studentIdData = payload.subdata(in: 0..<8)
                    let pinData = payload.subdata(in: 8..<12)
                    
                    let studentIdLong = UInt64(bigEndian: studentIdData.withUnsafeBytes { $0.loadUnaligned(as: UInt64.self) })
                    let pinInt = UInt32(bigEndian: pinData.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) })
                    
                    let result: [String: Any] = [
                        "studentId": String(studentIdLong),
                        "pin": String(pinInt),
                        "rssi": RSSI.intValue
                    ]
                    
                    self.sendEvent(withName: "onAttendanceReceived", body: result)
                }
            }
        }
        
        // 2. iOS broadcasts using Service UUID workaround
        if let serviceUUIDs = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
            for uuid in serviceUUIDs {
                let uuidData = uuid.data
                if uuidData.count == 16 {
                    let padding = uuidData.subdata(in: 0..<4)
                    if padding == Data(count: 4) {
                        let studentIdData = uuidData.subdata(in: 4..<12)
                        let pinData = uuidData.subdata(in: 12..<16)
                        
                        let studentIdLong = UInt64(bigEndian: studentIdData.withUnsafeBytes { $0.loadUnaligned(as: UInt64.self) })
                        let pinInt = UInt32(bigEndian: pinData.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) })
                        
                        let result: [String: Any] = [
                            "studentId": String(studentIdLong),
                            "pin": String(pinInt),
                            "rssi": RSSI.intValue
                        ]
                        
                        self.sendEvent(withName: "onAttendanceReceived", body: result)
                    }
                }
            }
        }
    }

    // MARK: - CBPeripheralManagerDelegate
    
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        // Handle state changes if needed
    }
}
