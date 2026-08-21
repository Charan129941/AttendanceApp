import React, { useState, useEffect, useRef } from 'react';
import {
  SafeAreaView, View, Text, TouchableOpacity, StyleSheet, Alert,
  TextInput, ScrollView, PermissionsAndroid, Platform, Share,
  StatusBar, Animated, Dimensions,
} from 'react-native';
import { BLEBroadcaster, bleEmitter } from './src/NativeModules';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width } = Dimensions.get('window');

// ── Color Palette ──────────────────────────────────────────────
const C = {
  bg:         '#0f172a',  // deep navy
  bgCard:     '#1e293b',  // card surface
  teal:       '#14b8a6',  // primary accent
  tealDark:   '#0d9488',
  purple:     '#a78bfa',  // secondary accent
  purpleDark: '#7c3aed',
  white:      '#ffffff',
  offWhite:   '#f1f5f9',
  lightGray:  '#94a3b8',
  midGray:    '#64748b',
  dark:       '#0f172a',
  red:        '#ef4444',
  redBg:      '#fef2f2',
  green:      '#22c55e',
  greenBg:    '#f0fdf4',
  greenBorder:'#86efac',
  border:     '#334155',
  inputBg:    '#f8fafc',
  inputBorder:'#e2e8f0',
  shadow:     '#000000',
};

export default function App() {
  const [mode, setMode] = useState<'IDLE' | 'FACULTY' | 'STUDENT'>('IDLE');
  
  // Faculty State
  const [collectedStudents, setCollectedStudents] = useState<any[]>([]);
  const [isClassActive, setIsClassActive] = useState(false);
  const [facultyPin, setFacultyPin] = useState('');
  const [proxyAlerts, setProxyAlerts] = useState<string[]>([]);
  
  // Anti-proxy: track which device address submitted which student ID
  const [deviceToStudent, setDeviceToStudent] = useState<{[key: string]: string}>({});
  
  // Student State
  const [studentStatus, setStudentStatus] = useState('Ready to mark attendance.');
  const [studentId, setStudentId] = useState('');
  const [studentPin, setStudentPin] = useState('');
  const [hasAttempted, setHasAttempted] = useState(false);
  const [usedPins, setUsedPins] = useState<string[]>([]);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();
  }, [mode]);

  // Load persisted used PINs from device storage on app start
  useEffect(() => {
    AsyncStorage.getItem('usedPins').then(data => {
      if (data) {
        try {
          const pins = JSON.parse(data);
          if (Array.isArray(pins)) setUsedPins(pins);
        } catch {}
      }
    });
  }, []);

  useEffect(() => {
    if (isClassActive) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [isClassActive]);

  useEffect(() => {
    async function requestPermissions() {
      if (Platform.OS === 'android') {
        try {
          const perms = [
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          ];
          if (Number(Platform.Version) >= 31) {
            perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
            perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE);
            perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
          }
          await PermissionsAndroid.requestMultiple(perms);
        } catch (err) {
          console.warn(err);
        }
      }
    }
    requestPermissions();
  }, []);

  useEffect(() => {
    const bleSub = bleEmitter.addListener('onAttendanceReceived', (event) => {
      if (mode === 'FACULTY') {
        const { studentId: receivedId, pin: receivedPin, rssi, deviceAddress } = event;
        
        // ONLY accept if the PIN matches what's on the board
        if (receivedPin === facultyPin) {
          // Anti-proxy check: has this device already submitted for a DIFFERENT student?
          if (deviceAddress && deviceAddress !== 'unknown') {
            setDeviceToStudent(prev => {
              const existingStudent = prev[deviceAddress];
              if (existingStudent && existingStudent !== receivedId) {
                // PROXY DETECTED! Same device, different student ID
                const msg = `⚠️ Proxy detected! Device tried to submit for ${receivedId} but already submitted for ${existingStudent}`;
                setProxyAlerts(alerts => [...alerts, msg]);
                Alert.alert(
                  '🚫 Proxy Attendance Detected!',
                  `The same device already marked attendance for enrollment ${existingStudent}. This attempt for enrollment ${receivedId} has been REJECTED.`
                );
                return prev; // Don't update mapping
              }
              // First time this device is seen, or same student — record it
              return { ...prev, [deviceAddress]: receivedId };
            });
          }

          setCollectedStudents(prev => {
            if (prev.find(s => s.studentId === receivedId)) return prev;
            return [...prev, { studentId: receivedId, rssi }];
          });
        }
      }
    });

    return () => {
      bleSub.remove();
    };
  }, [mode, facultyPin]);

  const startFacultySession = () => {
    // Generate random 4 digit PIN
    const newPin = Math.floor(1000 + Math.random() * 9000).toString();
    setFacultyPin(newPin);
    setIsClassActive(true);
    setCollectedStudents([]);
    setDeviceToStudent({});
    setProxyAlerts([]);
    BLEBroadcaster.startScanning();
  };

  const exportAttendance = async () => {
    setIsClassActive(false);
    BLEBroadcaster.stopScanning();
    setFacultyPin('');
    
    if (collectedStudents.length === 0) {
      Alert.alert("Info", "No students to export.");
      return;
    }

    try {
      const csvHeader = 'Enrollment Number, Signal Strength\n';
      const csvRows = collectedStudents.map(s => `${s.studentId},${s.rssi}`).join('\n');
      const csvString = csvHeader + csvRows;

      await Share.share({
        message: csvString,
        title: 'Export Attendance',
      });
    } catch (e: any) {
      Alert.alert("Export Error", e.message);
    }
  };

  const startStudentSession = async () => {
    if (hasAttempted) {
      Alert.alert("Notice", "only one chance to attempt the attendance");
      return;
    }
    if (!studentId || studentId.trim() === '') {
      Alert.alert("Required", "Please enter your Enrollment Number.");
      return;
    }
    if (!studentPin || studentPin.length !== 4) {
      Alert.alert("Required", "Please enter the 4-digit PIN shown on the board.");
      return;
    }

    // Check if this PIN was already used on this device (survives app restart)
    if (usedPins.includes(studentPin)) {
      Alert.alert("Notice", "only one chance to attempt the attendance");
      setHasAttempted(true);
      setStudentStatus('You have already marked attendance with this PIN.');
      return;
    }
    
    if (studentStatus.includes("Broadcasting")) {
      return;
    }

    setStudentStatus("Broadcasting attendance...");
    
    BLEBroadcaster.startBroadcasting(studentId, studentPin)
      .then(async () => {
        setStudentStatus('Broadcasting attendance successfully! You can close the app.');
        setHasAttempted(true);
        // Persist the used PIN to device storage so it survives app restart
        const updatedPins = [...usedPins, studentPin];
        setUsedPins(updatedPins);
        try {
          await AsyncStorage.setItem('usedPins', JSON.stringify(updatedPins));
        } catch {}
      })
      .catch(e => {
        console.error("BLE Error", e);
        setStudentStatus(`Error: ${e.message}`);
      });
  };

  const goBack = () => {
    if (mode === 'STUDENT') {
      BLEBroadcaster.stopBroadcasting().catch(() => {});
    } else if (mode === 'FACULTY') {
      BLEBroadcaster.stopScanning().catch(() => {});
    }
    fadeAnim.setValue(0);
    slideAnim.setValue(30);
    setMode('IDLE');
  };

  // ── Helper: signal strength to bars (1–4) ───────────────────
  const signalBars = (rssi: number) => {
    if (rssi >= -50) return 4;
    if (rssi >= -65) return 3;
    if (rssi >= -80) return 2;
    return 1;
  };

  // ═══════════════════════════════════════════════════════════════
  //  FACULTY SCREEN
  // ═══════════════════════════════════════════════════════════════
  if (mode === 'FACULTY') {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <Animated.View style={[s.screen, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>

          {/* Header */}
          <View style={s.topBar}>
            <TouchableOpacity onPress={goBack} style={s.backBtn}>
              <Text style={s.backIcon}>←</Text>
            </TouchableOpacity>
            <Text style={s.topTitle}>Faculty Dashboard</Text>
            <View style={{ width: 44 }} />
          </View>

          {/* PIN Card */}
          {isClassActive && facultyPin ? (
            <Animated.View style={[s.pinCard, { transform: [{ scale: pulseAnim }] }]}>
              <Text style={s.pinCardLabel}>CLASS PIN</Text>
              <Text style={s.pinCardDigits}>{facultyPin}</Text>
              <View style={s.pinLiveDot} />
              <Text style={s.pinLiveText}>LIVE — Scanning for students</Text>
            </Animated.View>
          ) : null}

          {/* Counter */}
          <View style={s.counterRow}>
            <View style={s.counterCard}>
              <Text style={s.counterNum}>{collectedStudents.length}</Text>
              <Text style={s.counterLabel}>Students Present</Text>
            </View>
            {proxyAlerts.length > 0 && (
              <View style={s.proxyCounterCard}>
                <Text style={s.proxyCounterNum}>{proxyAlerts.length}</Text>
                <Text style={s.proxyCounterLabel}>Proxy Blocked</Text>
              </View>
            )}
          </View>

          {/* Action Button */}
          <View style={{ marginBottom: 16 }}>
            {!isClassActive ? (
              <TouchableOpacity style={s.btnPrimary} onPress={startFacultySession} activeOpacity={0.85}>
                <Text style={s.btnPrimaryText}>▶  Start Class & Show PIN</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={s.btnDanger} onPress={exportAttendance} activeOpacity={0.85}>
                <Text style={s.btnDangerText}>■  Stop Class & Export</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Proxy Alerts */}
          {proxyAlerts.length > 0 && (
            <View style={s.proxyBox}>
              <Text style={s.proxyBoxTitle}>🚫 Proxy Attempts</Text>
              {proxyAlerts.map((msg, i) => (
                <Text key={i} style={s.proxyBoxMsg}>{msg}</Text>
              ))}
            </View>
          )}

          {/* Student List */}
          <ScrollView style={s.listWrap} showsVerticalScrollIndicator={false}>
            {collectedStudents.map((s2, i) => {
              const bars = signalBars(s2.rssi);
              return (
                <View key={i} style={[s.listCard, i % 2 === 0 ? s.listCardAlt : null]}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.listEnroll}>{s2.studentId}</Text>
                    <Text style={s.listRssi}>Signal: {s2.rssi} dBm</Text>
                  </View>
                  <View style={s.barsRow}>
                    {[1,2,3,4].map(b => (
                      <View key={b} style={[s.bar, { height: 6 + b * 4 }, b <= bars ? s.barActive : s.barInactive]} />
                    ))}
                  </View>
                </View>
              );
            })}
            {collectedStudents.length === 0 && (
              <View style={s.emptyState}>
                <Text style={s.emptyIcon}>📡</Text>
                <Text style={s.emptyText}>Waiting for students…</Text>
                <Text style={s.emptyHint}>Ask students to open the app and enter the PIN</Text>
              </View>
            )}
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  STUDENT SCREEN
  // ═══════════════════════════════════════════════════════════════
  if (mode === 'STUDENT') {
    const isBroadcasting = studentStatus.includes("Broadcasting");
    const isSuccess = studentStatus.includes("successfully");
    const isError = studentStatus.startsWith("Error");

    return (
      <SafeAreaView style={s.rootLight}>
        <StatusBar barStyle="dark-content" backgroundColor={C.offWhite} />
        <Animated.View style={[s.screenLight, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>

          {/* Header */}
          <View style={s.topBarLight}>
            <TouchableOpacity onPress={goBack} style={s.backBtnLight}>
              <Text style={s.backIconLight}>←</Text>
            </TouchableOpacity>
            <Text style={s.topTitleLight}>Mark Attendance</Text>
            <View style={{ width: 44 }} />
          </View>

          {/* Illustration area */}
          <View style={s.studentHero}>
            <View style={s.studentIconCircle}>
              <Text style={{ fontSize: 40 }}>🎓</Text>
            </View>
            <Text style={s.studentHeroTitle}>Enter your details below</Text>
          </View>

          {/* Inputs */}
          <View style={s.inputGroup}>
            <Text style={s.inputLabel}>Enrollment Number</Text>
            <TextInput
              style={s.inputField}
              placeholder="e.g. 92400118347"
              placeholderTextColor={C.lightGray}
              keyboardType="number-pad"
              value={studentId}
              onChangeText={setStudentId}
              editable={!hasAttempted}
            />
          </View>

          <View style={s.inputGroup}>
            <Text style={s.inputLabel}>Class PIN (from board)</Text>
            <TextInput
              style={s.inputField}
              placeholder="e.g. 1234"
              placeholderTextColor={C.lightGray}
              keyboardType="number-pad"
              maxLength={4}
              value={studentPin}
              onChangeText={setStudentPin}
              editable={!hasAttempted}
            />
          </View>

          {/* Status */}
          <View style={[
            s.statusBox,
            isSuccess && s.statusSuccess,
            isError && s.statusError,
            !isSuccess && !isError && isBroadcasting && s.statusBroadcasting,
          ]}>
            <Text style={[
              s.statusText,
              isSuccess && { color: C.tealDark },
              isError && { color: C.red },
            ]}>
              {isSuccess ? '✅ ' : isError ? '❌ ' : isBroadcasting ? '📡 ' : '📋 '}
              {studentStatus}
            </Text>
          </View>

          {/* Button */}
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            style={[s.btnPrimary, (isBroadcasting || hasAttempted) && s.btnDisabled]}
            onPress={startStudentSession}
            activeOpacity={0.85}
            disabled={isBroadcasting || hasAttempted}
          >
            <Text style={s.btnPrimaryText}>
              {hasAttempted ? '✓  Attendance Marked' : '📡  Mark Attendance'}
            </Text>
          </TouchableOpacity>
          {hasAttempted && (
            <Text style={s.oneChanceNote}>Only one attempt allowed per session</Text>
          )}
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  HOME / ROLE SELECTION SCREEN
  // ═══════════════════════════════════════════════════════════════
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <Animated.View style={[s.homeScreen, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>

        {/* Logo area */}
        <View style={s.logoArea}>
          <View style={s.logoCircle}>
            <Text style={s.logoIcon}>📶</Text>
          </View>
          <Text style={s.appName}>BLE Attendance</Text>
          <Text style={s.appTagline}>Offline  •  Secure  •  Instant</Text>
        </View>

        {/* Buttons */}
        <View style={s.roleButtons}>
          <TouchableOpacity
            style={s.roleBtnFaculty}
            onPress={() => { fadeAnim.setValue(0); slideAnim.setValue(30); setMode('FACULTY'); }}
            activeOpacity={0.85}
          >
            <Text style={s.roleBtnIcon}>👨‍🏫</Text>
            <View>
              <Text style={s.roleBtnTitle}>Faculty</Text>
              <Text style={s.roleBtnSub}>Start class & collect attendance</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={s.roleBtnStudent}
            onPress={() => { fadeAnim.setValue(0); slideAnim.setValue(30); setMode('STUDENT'); }}
            activeOpacity={0.85}
          >
            <Text style={s.roleBtnIcon}>🎓</Text>
            <View>
              <Text style={s.roleBtnTitle}>Student</Text>
              <Text style={s.roleBtnSub}>Mark your attendance via BLE</Text>
            </View>
          </TouchableOpacity>
        </View>

        <Text style={s.footerText}>No internet required. Uses Bluetooth Low Energy.</Text>
      </Animated.View>
    </SafeAreaView>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════════════════════════
const s = StyleSheet.create({
  // ── Roots ─────────────────────────────────────────────────────
  root:      { flex: 1, backgroundColor: C.bg },
  rootLight: { flex: 1, backgroundColor: C.offWhite },
  screen:      { flex: 1, padding: 20 },
  screenLight: { flex: 1, padding: 20 },
  homeScreen:  { flex: 1, padding: 24, justifyContent: 'center' },

  // ── Top Bar (dark) ────────────────────────────────────────────
  topBar:    { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  backBtn:   { width: 44, height: 44, borderRadius: 22, backgroundColor: C.bgCard, alignItems: 'center', justifyContent: 'center' },
  backIcon:  { color: C.white, fontSize: 22, fontWeight: '600' },
  topTitle:  { flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '700', color: C.white, letterSpacing: 0.3 },

  // ── Top Bar (light) ───────────────────────────────────────────
  topBarLight:    { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  backBtnLight:   { width: 44, height: 44, borderRadius: 22, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center', elevation: 2, shadowColor: C.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
  backIconLight:  { color: C.dark, fontSize: 22, fontWeight: '600' },
  topTitleLight:  { flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '700', color: C.dark, letterSpacing: 0.3 },

  // ── PIN Card ──────────────────────────────────────────────────
  pinCard:       { backgroundColor: C.teal, borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 16, elevation: 8, shadowColor: C.teal, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12 },
  pinCardLabel:  { fontSize: 14, fontWeight: '700', color: 'rgba(255,255,255,0.8)', letterSpacing: 2, marginBottom: 4 },
  pinCardDigits: { fontSize: 52, fontWeight: '900', color: C.white, letterSpacing: 12 },
  pinLiveDot:    { width: 8, height: 8, borderRadius: 4, backgroundColor: '#86efac', marginTop: 12, marginBottom: 4 },
  pinLiveText:   { fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: '500' },

  // ── Counters ──────────────────────────────────────────────────
  counterRow:     { flexDirection: 'row', gap: 12, marginBottom: 16 },
  counterCard:    { flex: 1, backgroundColor: C.bgCard, borderRadius: 16, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  counterNum:     { fontSize: 28, fontWeight: '800', color: C.green },
  counterLabel:   { fontSize: 12, color: C.lightGray, marginTop: 2, fontWeight: '500' },
  proxyCounterCard: { flex: 1, backgroundColor: '#2d1a1a', borderRadius: 16, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: '#5c2020' },
  proxyCounterNum:  { fontSize: 28, fontWeight: '800', color: C.red },
  proxyCounterLabel:{ fontSize: 12, color: '#fca5a5', marginTop: 2, fontWeight: '500' },

  // ── Buttons ───────────────────────────────────────────────────
  btnPrimary:     { backgroundColor: C.teal, borderRadius: 16, paddingVertical: 18, alignItems: 'center', elevation: 4, shadowColor: C.teal, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8 },
  btnPrimaryText: { color: C.white, fontSize: 17, fontWeight: '700', letterSpacing: 0.3 },
  btnDanger:      { backgroundColor: C.red, borderRadius: 16, paddingVertical: 18, alignItems: 'center', elevation: 4, shadowColor: C.red, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8 },
  btnDangerText:  { color: C.white, fontSize: 17, fontWeight: '700', letterSpacing: 0.3 },
  btnDisabled:    { backgroundColor: C.midGray, elevation: 0, shadowOpacity: 0 },

  // ── Proxy box ─────────────────────────────────────────────────
  proxyBox:      { backgroundColor: '#2d1a1a', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#5c2020' },
  proxyBoxTitle: { color: '#fca5a5', fontWeight: '700', fontSize: 14, marginBottom: 6 },
  proxyBoxMsg:   { color: '#fca5a5', fontSize: 11, marginBottom: 3, lineHeight: 16 },

  // ── Student List ──────────────────────────────────────────────
  listWrap:    { flex: 1, marginTop: 4 },
  listCard:    { flexDirection: 'row', alignItems: 'center', backgroundColor: C.bgCard, borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  listCardAlt: { backgroundColor: '#1a2536' },
  listEnroll:  { fontSize: 16, fontWeight: '600', color: C.white, marginBottom: 2 },
  listRssi:    { fontSize: 12, color: C.lightGray },
  barsRow:     { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  bar:         { width: 5, borderRadius: 2 },
  barActive:   { backgroundColor: C.green },
  barInactive: { backgroundColor: C.border },

  // ── Empty State ───────────────────────────────────────────────
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyIcon:  { fontSize: 48, marginBottom: 12 },
  emptyText:  { fontSize: 16, color: C.lightGray, fontWeight: '600' },
  emptyHint:  { fontSize: 13, color: C.midGray, marginTop: 4, textAlign: 'center' },

  // ── Student Hero ──────────────────────────────────────────────
  studentHero:       { alignItems: 'center', marginBottom: 28 },
  studentIconCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#e0f2fe', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  studentHeroTitle:  { fontSize: 16, color: C.midGray, fontWeight: '500' },

  // ── Inputs ────────────────────────────────────────────────────
  inputGroup: { marginBottom: 18 },
  inputLabel: { fontSize: 14, fontWeight: '600', color: C.dark, marginBottom: 8, letterSpacing: 0.2 },
  inputField: { backgroundColor: C.white, borderRadius: 14, borderWidth: 1.5, borderColor: C.inputBorder, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: C.dark, elevation: 1, shadowColor: C.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3 },

  // ── Status Box ────────────────────────────────────────────────
  statusBox:          { borderRadius: 12, padding: 14, marginBottom: 12, backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.inputBorder },
  statusSuccess:      { backgroundColor: C.greenBg, borderColor: C.greenBorder },
  statusError:        { backgroundColor: C.redBg, borderColor: '#fca5a5' },
  statusBroadcasting: { backgroundColor: '#eff6ff', borderColor: '#93c5fd' },
  statusText:         { fontSize: 14, color: C.midGray, textAlign: 'center', lineHeight: 20 },
  oneChanceNote:      { textAlign: 'center', fontSize: 12, color: C.midGray, marginTop: 10 },

  // ── Home / Role Selection ─────────────────────────────────────
  logoArea:    { alignItems: 'center', marginBottom: 48 },
  logoCircle:  { width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(20,184,166,0.15)', alignItems: 'center', justifyContent: 'center', marginBottom: 20, borderWidth: 2, borderColor: 'rgba(20,184,166,0.3)' },
  logoIcon:    { fontSize: 48 },
  appName:     { fontSize: 32, fontWeight: '800', color: C.white, letterSpacing: 0.5 },
  appTagline:  { fontSize: 14, color: C.lightGray, marginTop: 6, letterSpacing: 1 },
  roleButtons: { gap: 14, marginBottom: 40 },
  roleBtnFaculty: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.teal, borderRadius: 18, paddingVertical: 20, paddingHorizontal: 20, gap: 16, elevation: 6, shadowColor: C.teal, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10 },
  roleBtnStudent: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.purpleDark, borderRadius: 18, paddingVertical: 20, paddingHorizontal: 20, gap: 16, elevation: 6, shadowColor: C.purpleDark, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10 },
  roleBtnIcon:    { fontSize: 32 },
  roleBtnTitle:   { fontSize: 18, fontWeight: '700', color: C.white },
  roleBtnSub:     { fontSize: 12, color: 'rgba(255,255,255,0.75)', marginTop: 2 },
  footerText:     { textAlign: 'center', fontSize: 12, color: C.midGray },
});
