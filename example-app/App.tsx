import React, { useState } from 'react';
import { SafeAreaView, ScrollView, View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { RiviumFlagsProvider, useRiviumFlags } from '@rivium/flags-react-native';

// Public key from Rivium Console → Flags → Settings (rv_live_… / rv_test_…).
const API_KEY = 'YOUR_API_KEY';

export default function App() {
  return (
    <RiviumFlagsProvider config={{ apiKey: API_KEY, environment: 'production', debug: true }}>
      <FlagsScreen />
    </RiviumFlagsProvider>
  );
}

function FlagsScreen() {
  // Re-renders whenever new results arrive.
  const flags = useRiviumFlags();
  const [userId, setUserId] = useState('user-1');
  const [plan, setPlan] = useState('pro');
  const all = Object.values(flags.getAll()).sort((a, b) => a.key.localeCompare(b.key));
  const error = flags.client.lastError;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Rivium Flags</Text>
        <Text style={styles.muted}>Anonymous id: {flags.anonymousId}</Text>
        <Text>
          User: {flags.userId ?? '(signed out)'} · ready: {String(flags.isReady)}
        </Text>
        {error && (
          <Text style={styles.error}>
            Last error: {error.statusCode ?? 'network'} {error.code ?? ''} {error.message}
          </Text>
        )}

        <TextInput style={styles.input} value={userId} onChangeText={setUserId} placeholder="User id" />
        <TextInput style={styles.input} value={plan} onChangeText={setPlan} placeholder='Attribute "plan"' />
        <View style={styles.row}>
          <Button label="Identify" onPress={() => flags.identify(userId, { plan })} />
          <Button label="Refresh" onPress={() => flags.refresh()} />
          <Button label="Sign out" onPress={() => flags.reset()} />
          <Button label="New anon id" onPress={() => flags.resetAnonymousId()} />
        </View>

        <Text style={styles.section}>Typed getters</Text>
        <Line label={'isEnabled("new-checkout")'} value={String(flags.isEnabled('new-checkout'))} />
        <Line label={'getString("theme", "light")'} value={flags.getString('theme', 'light')} />
        <Line label={'getNumber("max-items", 10)'} value={String(flags.getNumber('max-items', 10))} />
        <Line label={'getDetail("missing-flag").reason'} value={flags.getDetail('missing-flag').reason} />

        <Text style={styles.section}>All results ({all.length})</Text>
        {all.map((f) => (
          <View key={f.key} style={styles.flag}>
            <Text style={styles.flagKey}>
              {f.enabled ? '●' : '○'} {f.key}
            </Text>
            <Text style={styles.muted}>
              {f.valueType} · {JSON.stringify(f.value)}
              {f.variant ? ` · variant ${f.variant}` : ''} · {f.reason}
            </Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.button} onPress={onPress}>
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.mono}>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  muted: { color: '#666', fontSize: 12 },
  error: { color: '#c62828' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { backgroundColor: '#3949ab', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  buttonText: { color: '#fff', fontWeight: '600' },
  section: { marginTop: 16, fontSize: 16, fontWeight: '600' },
  line: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  mono: { fontFamily: 'Courier', fontSize: 12, flexShrink: 1 },
  flag: { paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ddd' },
  flagKey: { fontWeight: '600' },
});
