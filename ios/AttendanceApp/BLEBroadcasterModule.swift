import Foundation
import CoreBluetooth

@objc(BLEBroadcaster)
class BLEBroadcasterModule: RCTEventEmitter, CBPeripheralManagerDelegate, CBCentralManagerDelegate {

    private var peripheralManager: CBPeripheralManager?
    private var centralManager: CBCentralManager?
    
    // The specific Service UUID used to bypass iOS advertising restrictions
    private let serviceUUID = CBUUID(string: "0000FFFF-0000-1000-8000-00805F9B34FB")
    
    private var isBroadcasting = false
    private var isScanning = false
    
    private var pendingBroadcastData: [String: Any]?
    
    override static func requiresMainQueueSetup() -> Bool {
        return true
    }
    
    override func supportedEvents() -> [String]! {
        return ["onAttendanceReceived"]
    }
    
    // MARK: - Broadcasting (Student)
    
    @objc
    func startBroadcasting(_ studentId: String, pin: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        let payload = "\(studentId):\(pin)"
        
        pendingBroadcastData = [
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
            CBAdvertisementDataLocalNameKey: payload // Packing payload into LocalName
        ]
        
        // Lazy Initialization
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
        // Lazy Initialization
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
            centralManager?.scanForPeripherals(withServices: [serviceUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
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
        
        guard let localName = advertisementData[CBAdvertisementDataLocalNameKey] as? String else { return }
        
        let components = localName.components(separatedBy: ":")
        if components.count == 2 {
            let studentId = components[0]
            let pin = components[1]
            let deviceAddress = peripheral.identifier.uuidString // Anti-proxy identifier
            
            self.sendEvent(withName: "onAttendanceReceived", body: [
                "studentId": studentId,
                "pin": pin,
                "rssi": RSSI.intValue,
                "deviceAddress": deviceAddress
            ])
        }
    }
}
