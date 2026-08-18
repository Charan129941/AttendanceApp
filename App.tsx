import React, { useState, useEffect } from 'react';
import { SafeAreaView, View, Text, Button, StyleSheet, Alert, TextInput, ScrollView, PermissionsAndroid, Platform, Share } from 'react-native';
import { BLEBroadcaster, bleEmitter } from './src/NativeModules';

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

  const startStudentSession = () => {
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
    
    if (studentStatus.includes("Broadcasting")) {
      return;
    }

    setStudentStatus("Broadcasting attendance...");
    
    BLEBroadcaster.startBroadcasting(studentId, studentPin)
      .then(() => {
        setStudentStatus('Broadcasting attendance successfully! You can close the app.');
        setHasAttempted(true);
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
    setMode('IDLE');
  };

  if (mode === 'FACULTY') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Button title="< Back" onPress={goBack} color="#888" />
          <Text style={styles.title}>Faculty Dashboard</Text>
          <View style={{width: 60}} />
        </View>

        {isClassActive && facultyPin ? (
          <View style={styles.pinContainer}>
            <Text style={styles.pinLabel}>CLASS PIN</Text>
            <Text style={styles.pinText}>{facultyPin}</Text>
          </View>
        ) : null}

        <Text style={styles.subtitle}>
          Total Students Present: {collectedStudents.length}
        </Text>
        
        <View style={styles.buttonContainer}>
          {!isClassActive ? (
            <Button title="Start Class & Show PIN" onPress={startFacultySession} />
          ) : (
            <Button title="Stop Class & Export" color="red" onPress={exportAttendance} />
          )}
        </View>

        <ScrollView style={styles.listContainer}>
          {proxyAlerts.length > 0 && (
            <View style={{backgroundColor: '#ffebee', padding: 10, borderRadius: 8, marginBottom: 10}}>
              <Text style={{color: '#c62828', fontWeight: 'bold', marginBottom: 4}}>🚫 Proxy Attempts:</Text>
              {proxyAlerts.map((msg, i) => (
                <Text key={i} style={{color: '#c62828', fontSize: 12, marginBottom: 2}}>{msg}</Text>
              ))}
            </View>
          )}
          {collectedStudents.map((s, i) => (
            <View key={i} style={styles.listItem}>
              <Text style={styles.listText}>Enrollment: {s.studentId}</Text>
              <Text style={styles.signalText}>(Signal: {s.rssi} dBm)</Text>
            </View>
          ))}
          {collectedStudents.length === 0 && (
            <Text style={{textAlign: 'center', color: '#999', marginTop: 20}}>
              Waiting for students...
            </Text>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (mode === 'STUDENT') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Button title="< Back" onPress={goBack} color="#888" />
          <Text style={styles.title}>Student Portal</Text>
          <View style={{width: 60}} />
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.label}>Enrollment Number:</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 92400118347"
            keyboardType="number-pad"
            value={studentId}
            onChangeText={setStudentId}
          />
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.label}>Class PIN (from board):</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 1234"
            keyboardType="number-pad"
            maxLength={4}
            value={studentPin}
            onChangeText={setStudentPin}
          />
        </View>

        <Text style={styles.status}>{studentStatus}</Text>
        
        <View style={styles.buttonContainer}>
          <Button 
            title="Mark Attendance" 
            onPress={startStudentSession} 
            disabled={studentStatus.includes("Broadcasting")}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Attendance (BLE PIN)</Text>
      <Text style={styles.subtitle}>Select your role below</Text>
      <View style={styles.buttonContainer}>
        <Button title="Open as Faculty" onPress={() => setMode('FACULTY')} />
        <View style={{height: 20}} />
        <Button title="Open as Student" onPress={() => setMode('STUDENT')} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, justifyContent: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 24, fontWeight: 'bold', textAlign: 'center' },
  subtitle: { fontSize: 16, textAlign: 'center', marginBottom: 20, color: '#666' },
  status: { fontSize: 14, textAlign: 'center', marginVertical: 20, color: 'blue' },
  buttonContainer: { marginVertical: 20 },
  inputContainer: { marginBottom: 20 },
  label: { fontSize: 16, marginBottom: 5, color: '#333' },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, borderRadius: 5, fontSize: 16 },
  listContainer: { flex: 1, marginTop: 10, borderWidth: 1, borderColor: '#eee', borderRadius: 5, padding: 10 },
  listItem: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  listText: { fontSize: 16, fontWeight: '500' },
  signalText: { fontSize: 14, color: '#888' },
  pinContainer: { alignItems: 'center', marginVertical: 20, padding: 20, backgroundColor: '#f9f9f9', borderRadius: 10, borderWidth: 2, borderColor: '#007AFF' },
  pinLabel: { fontSize: 18, color: '#007AFF', fontWeight: 'bold', marginBottom: 5 },
  pinText: { fontSize: 48, fontWeight: '900', color: '#333', letterSpacing: 5 }
});
