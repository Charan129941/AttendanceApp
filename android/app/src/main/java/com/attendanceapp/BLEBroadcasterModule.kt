package com.attendanceapp

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import androidx.core.content.ContextCompat

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections

/**
 * BLEBroadcasterModule — React Native native module for BLE-based
 * attendance broadcasting and scanning.
 *
 * Protocol constants (shared with iOS):
 *   COMPANY_ID = 0xFFFF (development/test)
 *   Payload layout (12 bytes, big-endian):
 *     [StudentID 8 bytes][PIN 4 bytes]
 *   Advertising interval: ADVERTISE_MODE_LOW_LATENCY (~100 ms)
 */
class BLEBroadcasterModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val MODULE_NAME = "BLEBroadcasterModule"

        // BLE protocol constants
        const val COMPANY_ID = 0xFFFF   // Development / test manufacturer ID
        const val PAYLOAD_SIZE = 12      // 8 + 4 bytes

        // Event emitted to React Native JS layer
        const val EVENT_ATTENDANCE_RECEIVED = "onAttendanceReceived"
    }

    // ── Bluetooth handles ────────────────────────────────────────────
    private var bluetoothAdapter: BluetoothAdapter? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var scanner: BluetoothLeScanner? = null

    private var advertiseCallback: AdvertiseCallback? = null
    private var scanCallback: ScanCallback? = null

    @Volatile
    private var isAdvertising = false

    @Volatile
    private var isScanning = false

    /** Set of studentIds already emitted during the current scan session. */
    private val seenStudentIds: MutableSet<String> =
        Collections.synchronizedSet(mutableSetOf())

    override fun getName(): String = MODULE_NAME

    // ─────────────────────────────────────────────────────────────────
    //  Bluetooth Initialization Helpers
    // ─────────────────────────────────────────────────────────────────

    /**
     * Ensures the BluetoothAdapter is available and enabled.
     * Returns null and rejects the promise if not.
     */
    private fun ensureBluetoothReady(promise: Promise): BluetoothAdapter? {
        val ctx = reactApplicationContext
        val bluetoothManager =
            ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        if (bluetoothManager == null) {
            promise.reject("ERR_BLE_UNAVAILABLE", "BluetoothManager is not available on this device")
            return null
        }

        val adapter = bluetoothManager.adapter
        if (adapter == null) {
            promise.reject("ERR_BLE_UNAVAILABLE", "Bluetooth is not supported on this device")
            return null
        }

        if (!adapter.isEnabled) {
            promise.reject(
                "ERR_BLE_DISABLED",
                "Bluetooth is turned off. Enable it before using BLE features."
            )
            return null
        }

        bluetoothAdapter = adapter
        return adapter
    }

    /**
     * Checks that the required BLE runtime permissions are granted.
     * On Android 12+ (API 31), BLUETOOTH_ADVERTISE and BLUETOOTH_SCAN are needed.
     * On older versions, ACCESS_FINE_LOCATION is required for scanning.
     */
    private fun checkPermissions(forAdvertise: Boolean, forScan: Boolean, promise: Promise): Boolean {
        val ctx = reactApplicationContext
        val missing = mutableListOf<String>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+
            if (forAdvertise && ContextCompat.checkSelfPermission(
                    ctx, Manifest.permission.BLUETOOTH_ADVERTISE
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                missing.add("BLUETOOTH_ADVERTISE")
            }
            if (forScan && ContextCompat.checkSelfPermission(
                    ctx, Manifest.permission.BLUETOOTH_SCAN
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                missing.add("BLUETOOTH_SCAN")
            }
            // BLUETOOTH_CONNECT may be needed for some operations
            if (forScan && ContextCompat.checkSelfPermission(
                    ctx, Manifest.permission.BLUETOOTH_CONNECT
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                missing.add("BLUETOOTH_CONNECT")
            }
        } else {
            // Pre-Android 12: location permission required for BLE scanning
            if (forScan && ContextCompat.checkSelfPermission(
                    ctx, Manifest.permission.ACCESS_FINE_LOCATION
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                missing.add("ACCESS_FINE_LOCATION")
            }
        }

        if (missing.isNotEmpty()) {
            promise.reject(
                "ERR_PERMISSION_DENIED",
                "Missing permissions: ${missing.joinToString(", ")}. " +
                    "Request them from the JS layer before calling this method."
            )
            return false
        }
        return true
    }

    // ─────────────────────────────────────────────────────────────────
    //  Payload Encoding / Decoding
    // ─────────────────────────────────────────────────────────────────

    /**
     * Builds the 12-byte BLE manufacturer-specific payload.
     *
     * Layout (big-endian):
     *   Bytes  0..7   — StudentID (8 bytes, Long)
     *   Bytes  8..11  — PIN       (4 bytes, Int)
     *
     * @param studentId  Decimal string parseable as a 64-bit integer
     * @param pin        Decimal string parseable as a 32-bit integer
     */
    private fun buildPayload(
        studentId: String,
        pin: String
    ): ByteArray {
        val studentIdLong = studentId.toLong()
        val pinInt = pin.toInt()

        val buffer = ByteBuffer.allocate(PAYLOAD_SIZE).order(ByteOrder.BIG_ENDIAN)
        buffer.putLong(studentIdLong)      // bytes 0..7
        buffer.putInt(pinInt)              // bytes 8..11
        return buffer.array()
    }

    /**
     * Decodes a 12-byte payload back into its constituent fields.
     *
     * @return A WritableMap with keys: studentId, pin
     *         or null if the payload is malformed.
     */
    private fun decodePayload(payload: ByteArray): WritableMap? {
        if (payload.size < PAYLOAD_SIZE) {
            android.util.Log.w("BLEBroadcaster", "Payload size ${payload.size} is less than required $PAYLOAD_SIZE")
            return null
        }

        val buffer = ByteBuffer.wrap(payload).order(ByteOrder.BIG_ENDIAN)
        val studentIdLong = buffer.long
        val pinInt = buffer.int

        val map: WritableMap = Arguments.createMap()
        map.putString("studentId", studentIdLong.toString())
        map.putString("pin", pinInt.toString())
        return map
    }

    // ─────────────────────────────────────────────────────────────────
    //  startBroadcasting
    // ─────────────────────────────────────────────────────────────────

    @ReactMethod
    fun startBroadcasting(studentId: String, pin: String, promise: Promise) {
        if (isAdvertising) {
            promise.reject("ERR_ALREADY_ADVERTISING", "BLE advertising is already active")
            return
        }

        val adapter = ensureBluetoothReady(promise) ?: return
        if (!checkPermissions(forAdvertise = true, forScan = false, promise = promise)) return

        val leAdvertiser = adapter.bluetoothLeAdvertiser
        if (leAdvertiser == null) {
            promise.reject(
                "ERR_BLE_ADVERTISER",
                "BLE Advertiser is not available. The device may not support BLE peripheral mode."
            )
            return
        }

        val payload: ByteArray
        try {
            payload = buildPayload(studentId, pin)
        } catch (e: NumberFormatException) {
            promise.reject("ERR_INVALID_PAYLOAD", "studentId and pin must be valid numbers: ${e.message}", e)
            return
        }

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)  // ~100 ms interval
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .setTimeout(0)  // Advertise indefinitely until stopped
            .build()

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addManufacturerData(COMPANY_ID, payload)
            .build()

        val callback = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                isAdvertising = true
                advertiser = leAdvertiser
                promise.resolve(null)
            }

            override fun onStartFailure(errorCode: Int) {
                isAdvertising = false
                val errorMsg = when (errorCode) {
                    ADVERTISE_FAILED_DATA_TOO_LARGE ->
                        "Advertise data is too large"
                    ADVERTISE_FAILED_TOO_MANY_ADVERTISERS ->
                        "Too many concurrent advertisers"
                    ADVERTISE_FAILED_ALREADY_STARTED ->
                        "Advertising has already started"
                    ADVERTISE_FAILED_INTERNAL_ERROR ->
                        "Internal BLE advertiser error"
                    ADVERTISE_FAILED_FEATURE_UNSUPPORTED ->
                        "BLE advertising is not supported on this device"
                    else ->
                        "Unknown advertise error (code $errorCode)"
                }
                promise.reject("ERR_ADVERTISE_FAILED", errorMsg)
            }
        }

        advertiseCallback = callback

        try {
            leAdvertiser.startAdvertising(settings, data, callback)
        } catch (e: SecurityException) {
            promise.reject("ERR_PERMISSION_DENIED", "BLE advertising permission denied", e)
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  stopBroadcasting
    // ─────────────────────────────────────────────────────────────────

    @ReactMethod
    fun stopBroadcasting(promise: Promise) {
        if (!isAdvertising) {
            promise.reject("ERR_NOT_ADVERTISING", "BLE advertising is not active")
            return
        }

        try {
            advertiseCallback?.let { cb ->
                advertiser?.stopAdvertising(cb)
            }
        } catch (e: SecurityException) {
            promise.reject("ERR_PERMISSION_DENIED", "BLE advertising permission denied during stop", e)
            return
        } catch (e: Exception) {
            promise.reject("ERR_STOP_ADVERTISING", "Failed to stop advertising: ${e.message}", e)
            return
        } finally {
            isAdvertising = false
            advertiseCallback = null
            advertiser = null
        }

        promise.resolve(null)
    }

    // ─────────────────────────────────────────────────────────────────
    //  startScanning
    // ─────────────────────────────────────────────────────────────────

    @ReactMethod
    fun startScanning(promise: Promise) {
        if (isScanning) {
            promise.reject("ERR_ALREADY_SCANNING", "BLE scanning is already active")
            return
        }

        val adapter = ensureBluetoothReady(promise) ?: return
        if (!checkPermissions(forAdvertise = false, forScan = true, promise = promise)) return

        val leScanner = adapter.bluetoothLeScanner
        if (leScanner == null) {
            promise.reject(
                "ERR_BLE_SCANNER",
                "BLE Scanner is not available. Bluetooth may have just been turned off."
            )
            return
        }

        // Reset de-duplication set for this scan session
        seenStudentIds.clear()

        // We use an empty filter and manually check the manufacturer data
        // in the callback, because some Android devices pad or strip BLE payloads
        // breaking the hardware filter mask.
        val scanFilter = ScanFilter.Builder().build()

        val scanSettings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0)  // Report results immediately
            .build()

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult?) {
                result ?: return
                handleScanResult(result)
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>?) {
                results?.forEach { handleScanResult(it) }
            }

            override fun onScanFailed(errorCode: Int) {
                val errorMsg = when (errorCode) {
                    SCAN_FAILED_ALREADY_STARTED ->
                        "Scan already started"
                    SCAN_FAILED_APPLICATION_REGISTRATION_FAILED ->
                        "Application registration failed"
                    SCAN_FAILED_INTERNAL_ERROR ->
                        "Internal BLE scanner error"
                    SCAN_FAILED_FEATURE_UNSUPPORTED ->
                        "BLE scanning feature unsupported"
                    else ->
                        "Unknown scan error (code $errorCode)"
                }
                android.util.Log.e("BLEBroadcaster", "Scan failed: $errorMsg")
                
                // Emit a scan error event so JS can react
                val params: WritableMap = Arguments.createMap()
                params.putString("error", errorMsg)
                params.putInt("errorCode", errorCode)
                reactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("onScanError", params)
            }
        }

        scanCallback = callback
        scanner = leScanner

        try {
            leScanner.startScan(listOf(scanFilter), scanSettings, callback)
        } catch (e: SecurityException) {
            promise.reject("ERR_PERMISSION_DENIED", "BLE scan permission denied", e)
            return
        }

        isScanning = true
        promise.resolve(null)
    }

    /**
     * Processes a single BLE scan result: extracts the manufacturer payload,
     * decodes it, de-duplicates by studentId, and emits the event.
     */
    private fun handleScanResult(result: ScanResult) {
        val scanRecord = result.scanRecord ?: return
        val manufacturerData = scanRecord.getManufacturerSpecificData(COMPANY_ID) ?: return

        // Wait, Android sometimes pads the data. As long as we have our 24 bytes, we are good.
        if (manufacturerData.size < PAYLOAD_SIZE) {
            return
        }

        val decoded = decodePayload(manufacturerData) ?: return

        val studentId = decoded.getString("studentId") ?: return

        // De-duplicate: only emit once per student per scan session
        if (!seenStudentIds.add(studentId)) {
            return
        }

        // Add RSSI to the event
        decoded.putInt("rssi", result.rssi)

        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_ATTENDANCE_RECEIVED, decoded)
    }

    // ─────────────────────────────────────────────────────────────────
    //  stopScanning
    // ─────────────────────────────────────────────────────────────────

    @ReactMethod
    fun stopScanning(promise: Promise) {
        if (!isScanning) {
            promise.reject("ERR_NOT_SCANNING", "BLE scanning is not active")
            return
        }

        try {
            scanCallback?.let { cb ->
                scanner?.stopScan(cb)
            }
        } catch (e: SecurityException) {
            promise.reject("ERR_PERMISSION_DENIED", "BLE scan permission denied during stop", e)
            return
        } catch (e: Exception) {
            promise.reject("ERR_STOP_SCANNING", "Failed to stop scanning: ${e.message}", e)
            return
        } finally {
            isScanning = false
            scanCallback = null
            scanner = null
            seenStudentIds.clear()
        }

        promise.resolve(null)
    }

    // ─────────────────────────────────────────────────────────────────
    //  React Native event listener bookkeeping
    // ─────────────────────────────────────────────────────────────────

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
        // Required by React Native's NativeEventEmitter
    }

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {
        // Required by React Native's NativeEventEmitter
    }
}
