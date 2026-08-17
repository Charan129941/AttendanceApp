package com.attendanceapp

import android.view.View

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * NativeModulesPackage — registers all attendance-system native modules
 * with the React Native bridge.
 *
 * Add this package to your MainApplication's getPackages() list:
 *
 *   override fun getPackages(): List<ReactPackage> =
 *       PackageList(this).packages.apply {
 *           add(NativeModulesPackage())
 *       }
 */
class NativeModulesPackage : ReactPackage {

    /**
     * Creates and returns the list of native modules exposed to JavaScript.
     *
     * Currently registers:
     *   - AudioDSPModule   — ultrasonic FSK audio token emission & listening
     *   - BLEBroadcasterModule — BLE attendance broadcasting & scanning
     */
    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> {
        return listOf(
            BLEBroadcasterModule(reactContext)
        )
    }

    /**
     * Returns an empty list — this package does not expose any custom
     * native UI view managers.
     */
    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<View, ReactShadowNode<*>>> {
        return emptyList()
    }
}
