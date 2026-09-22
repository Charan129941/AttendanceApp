import Foundation
import CoreBluetooth

@objc(BLEBroadcasterModule)
class BLEBroadcasterModule: RCTEventEmitter, CBPeripheralManagerDelegate, CBCentralManagerDelegate {

    private var peripheralManager: CBPeripheralManager?
    private var centralManager: CBCentralManager?
    
    private var isBroadcasting = false
    private var isScanning = false
    
    private var pendingBroadcastData: [String: Any]?
    
    // Set to avoid emitting duplicate attendances in the same session
    private var seenStudents = Set<String>()
    
    override static func requiresMainQueueSetup() -> Bool {
        return true
    }
    
    override func supportedEvents() -> [String]! {
        return ["onAttendanceReceived"]
    }
    
    // MARK: - Broadcasting (Student)
    
    @objc
    func startBroadcasting(_ studentId: String, pin: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        
        guard let studentIdInt = Int64(studentId), let pinInt = Int32(pin) else {
            reject("ERR_INVALID_INPUT", "Student ID and PIN must be numeric", nil)
            return
        }
        
        // Android expects: 8 bytes StudentID + 4 bytes PIN (Big Endian)
        var beStudentId = studentIdInt.bigEndian
        var bePin = pinInt.bigEndian
        
        var payload = Data()
        payload.append(Data(bytes: &beStudentId, count: 8))
        payload.append(Data(bytes: &bePin, count: 4))
        
        // iOS workaround: Embed the 12-byte payload into a 16-byte Service UUID
        // Prefix with 0x0000FFFF
        var prefix: [UInt8] = [0x00, 0x00, 0xFF, 0xFF]
        var uuidData = Data(prefix)
        uuidData.append(payload)
        
        // Fallback for Androids scanning for Manufacturer Data: we cannot broadcast it natively on iOS,
        // but we broadcast the Service UUID which the updated Android app looks for.
        let serviceUUID = CBUUID(data: uuidData)
        
        pendingBroadcastData = [
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID]
        ]
        
        if peripheralManager == nil {
            peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
        } else if peripheralManager?.state == .poweredOn {
            startActualBroadcasting()
        }
        
        resolve(nil)
    }
    
    @objc
    func stopBroadcasting(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        peripheralManager?.stopAdvertising()
        isBroadcasting = false
        resolve(nil)
    }
    
    private func startActualBroadcasting() {
        if let data = pendingBroadcastData, !isBroadcasting {
            peripheralManager?.startAdvertising(data)
            isBroadcasting = true
        }
    }
    
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if peripheral.state == .poweredOn && pendingBroadcastData != nil {
            startActualBroadcasting()
        } else if peripheral.state == .unsupported {
            print("BLE Broadcasting is unsupported on this device (e.g. Simulator).")
        }
    }
    
    // MARK: - Scanning (Faculty)
    
    @objc
    func startScanning(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        seenStudents.removeAll()
        if centralManager == nil {
            centralManager = CBCentralManager(delegate: self, queue: nil)
        } else if centralManager?.state == .poweredOn {
            startActualScanning()
        }
        resolve(nil)
    }
    
    @objc
    func stopScanning(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        centralManager?.stopScan()
        isScanning = false
        resolve(nil)
    }
    
    private func startActualScanning() {
        if !isScanning {
            // Scan for everything, filter manually, because Android broadcasts ManufacturerData
            // and other iPhones broadcast ServiceUUIDs.
            centralManager?.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
            isScanning = true
        }
    }
    
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn && !isScanning {
            startActualScanning()
        } else if central.state == .unsupported {
            print("BLE Scanning is unsupported on this device.")
        }
    }
    
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String : Any], rssi RSSI: NSNumber) {
        
        var payload: Data?
        let deviceAddress = peripheral.identifier.uuidString // iOS proxy identifier
        
        // 1. Try to read from Manufacturer Data (Android Broadcasters)
        if let manufacturerData = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data {
            // Apple strips the Company ID from the Data object, but wait, usually Apple parses it out.
            // Actually, CBAdvertisementDataManufacturerDataKey contains the Company ID (2 bytes) + Payload.
            // Our COMPANY_ID is 0xFFFF.
            if manufacturerData.count >= 14 { // 2 bytes ID + 12 bytes payload
                let companyIdBytes = [UInt8](manufacturerData.prefix(2))
                if companyIdBytes[0] == 0xFF && companyIdBytes[1] == 0xFF {
                    payload = manufacturerData.subdata(in: 2..<14)
                }
            }
        }
        
        // 2. Try to read from Service UUIDs (iOS Broadcasters)
        if payload == nil {
            if let serviceUUIDs = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
                for uuid in serviceUUIDs {
                    let uuidData = uuid.data
                    if uuidData.count == 16 {
                        let bytes = [UInt8](uuidData)
                        if bytes[0] == 0x00 && bytes[1] == 0x00 && bytes[2] == 0xFF && bytes[3] == 0xFF {
                            payload = uuidData.subdata(in: 4..<16)
                            break
                        }
                    }
                }
            }
        }
        
        guard let validPayload = payload, validPayload.count == 12 else { return }
        
        // Decode payload
        var studentIdRaw: UInt64 = 0
        _ = withUnsafeMutableBytes(of: &studentIdRaw) { dest in
            validPayload.copyBytes(to: dest, from: 0..<8)
        }
        let studentId = Int64(bitPattern: UInt64(bigEndian: studentIdRaw))
        let studentIdStr = String(studentId)
        
        if seenStudents.contains(studentIdStr) {
            return
        }
        seenStudents.insert(studentIdStr)
        
        var pinRaw: UInt32 = 0
        _ = withUnsafeMutableBytes(of: &pinRaw) { dest in
            validPayload.copyBytes(to: dest, from: 8..<12)
        }
        let pin = Int32(bitPattern: UInt32(bigEndian: pinRaw))
        let pinStr = String(pin)
        
        self.sendEvent(withName: "onAttendanceReceived", body: [
            "studentId": studentIdStr,
            "pin": pinStr,
            "rssi": RSSI.intValue,
            "deviceAddress": deviceAddress
        ])
    }
}
