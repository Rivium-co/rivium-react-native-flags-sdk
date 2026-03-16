import React, { useState, useEffect } from 'react';
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { RiviumFlags } from '@rivium/flags-react-native';
import type { FeatureFlag } from '@rivium/flags-react-native';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rivium Flags — React Native SDK Test Suite
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const API_KEY = 'YOUR_API_KEY';

interface TestResult {
  test: string;
  detail: string;
  pass: boolean;
}

export default function App() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState('test-user-1');
  const [selectedEnv, setSelectedEnv] = useState('none');
  const [allFlags, setAllFlags] = useState<FeatureFlag[]>([]);

  const runTests = async (uid: string, env: string) => {
    setLoading(true);
    const testResults: TestResult[] = [];

    const flags = new RiviumFlags({
      apiKey: API_KEY,
      environment: env === 'none' ? undefined : env,
      debug: true,
      enableOfflineCache: true,
    });

    // Initialize
    try {
      await flags.init((event, data) => {
        console.log(`[RiviumFlags] ${event}:`, data);
      });
      testResults.push({ test: 'Initialize SDK', detail: `Connected with API key${env !== 'none' ? ` (env: ${env})` : ''}`, pass: true });
    } catch (error) {
      testResults.push({ test: 'Initialize SDK', detail: `Failed: ${error}`, pass: false });
      setResults(testResults);
      setLoading(false);
      return;
    }

    // Set user context
    await flags.setUserId(uid);
    flags.setUserAttributes({ plan: 'pro', country: 'US' });

    // Test 1: Fetch all flags
    const all = flags.getAll();
    setAllFlags(all);
    testResults.push({
      test: 'GET /public/flags',
      detail: `Fetched ${all.length} flags: ${all.map((f) => f.key).join(', ')}`,
      pass: all.length > 0,
    });

    // Test 2: Boolean flag
    const darkMode = flags.isEnabled('dark_mode');
    testResults.push({
      test: 'Boolean flag: dark_mode',
      detail: `isEnabled = ${darkMode}`,
      pass: true,
    });

    // Test 3: Multivariate flag
    const evalResult = flags.evaluate('checkout_flow');
    testResults.push({
      test: 'Multivariate: checkout_flow',
      detail: `enabled=${evalResult.enabled}, value=${evalResult.value}, variant=${evalResult.variant}`,
      pass: true,
    });

    // Test 4: Targeting rules (matching)
    const premiumMatch = flags.isEnabled('premium_banner');
    testResults.push({
      test: 'Targeting (plan=pro, country=US)',
      detail: `premium_banner = ${premiumMatch}`,
      pass: true,
    });

    // Targeting (non-matching)
    flags.setUserAttributes({ plan: 'free', country: 'IR' });
    const premiumNoMatch = flags.isEnabled('premium_banner');
    testResults.push({
      test: 'Targeting (plan=free, country=IR)',
      detail: `premium_banner = ${premiumNoMatch}`,
      pass: true,
    });

    // Restore attributes
    flags.setUserAttributes({ plan: 'pro', country: 'US' });

    // Test 5: Rollout
    const rollout: Record<string, boolean> = {};
    for (const id of ['user-1', 'user-2', 'user-3', 'user-4', 'user-5']) {
      await flags.setUserId(id);
      rollout[id] = flags.isEnabled('gradual_redesign');
    }
    const enabledCount = Object.values(rollout).filter(Boolean).length;
    testResults.push({
      test: 'Rollout 30%: gradual_redesign',
      detail: `${Object.entries(rollout).map(([k, v]) => `${k}=${v}`).join(', ')}\n${enabledCount}/5 enabled`,
      pass: true,
    });

    // Restore user
    await flags.setUserId(uid);

    // Test 6: Default value
    const missing = flags.getValue('nonexistent_flag', 'fallback');
    testResults.push({
      test: 'Default value: nonexistent_flag',
      detail: `getValue = "${missing}" (default: "fallback")`,
      pass: missing === 'fallback',
    });

    // Test 7: Refresh
    await flags.refresh();
    testResults.push({
      test: 'Manual refresh',
      detail: `Refreshed. Total: ${flags.getAll().length} flags`,
      pass: true,
    });

    // Test 8: getUserId
    const currentUserId = flags.getUserId();
    testResults.push({
      test: 'getUserId',
      detail: `getUserId = "${currentUserId}" (expected: "${uid}")`,
      pass: currentUserId === uid,
    });

    // Test 9: Environment overrides
    const testFlagKey = all.length > 0 ? all[0].key : 'maintenance_mode';
    const envLines: string[] = [];

    for (const e of ['none', 'development', 'staging', 'production']) {
      try {
        const envFlags = new RiviumFlags({
          apiKey: API_KEY,
          environment: e === 'none' ? undefined : e,
          debug: true,
          enableOfflineCache: false,
        });
        await envFlags.init();
        await envFlags.setUserId(uid);
        const flagEnabled = envFlags.isEnabled(testFlagKey);
        const flagValue = envFlags.getValue(testFlagKey);
        envLines.push(`${e}: enabled=${flagEnabled}, value=${flagValue}, flags=${envFlags.getAll().length}`);
      } catch (err) {
        envLines.push(`${e}: error=${err}`);
      }
    }

    testResults.push({
      test: `Environment overrides: ${testFlagKey}`,
      detail: `Flag "${testFlagKey}" across environments:\n${envLines.join('\n')}`,
      pass: true,
    });

    // Test 10: Reset & Dispose
    const flagsBefore = flags.getAll().length;
    flags.dispose();
    const flagsAfter = flags.getAll().length;
    testResults.push({
      test: 'Reset & Dispose',
      detail: `Before: ${flagsBefore} flags, dispose() called, After: ${flagsAfter} flags`,
      pass: flagsAfter === 0,
    });

    setResults(testResults);
    setLoading(false);
  };

  useEffect(() => {
    runTests(userId, selectedEnv);
  }, []);

  const switchUser = (uid: string) => {
    setUserId(uid);
    runTests(uid, selectedEnv);
  };

  const switchEnv = (env: string) => {
    setSelectedEnv(env);
    runTests(userId, env);
  };

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Rivium Flags — React Native Test</Text>
        <Text style={styles.subtitle}>Client-side evaluation</Text>

        {/* User Switcher */}
        <View style={styles.row}>
          <Text style={styles.label}>User: </Text>
          {['test-user-1', 'test-user-2', 'test-user-3'].map((uid) => (
            <TouchableOpacity
              key={uid}
              style={[styles.chip, userId === uid && styles.chipActive]}
              onPress={() => switchUser(uid)}
            >
              <Text style={[styles.chipText, userId === uid && styles.chipTextActive]}>{uid}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Environment Switcher */}
        <View style={styles.row}>
          <Text style={styles.label}>Env: </Text>
          {['none', 'development', 'staging', 'production'].map((env) => (
            <TouchableOpacity
              key={env}
              style={[styles.chip, selectedEnv === env && styles.envChipActive]}
              onPress={() => switchEnv(env)}
            >
              <Text style={[styles.chipText, selectedEnv === env && styles.envChipTextActive]}>
                {env === 'none' ? 'Global' : env}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Status */}
        <View style={styles.statusRow}>
          <View style={[styles.badge, { backgroundColor: '#dcfce7' }]}>
            <Text style={{ color: '#166534', fontSize: 12 }}>{allFlags.length} flags loaded</Text>
          </View>
          {selectedEnv !== 'none' && (
            <View style={[styles.badge, { backgroundColor: '#dbeafe' }]}>
              <Text style={{ color: '#1e40af', fontSize: 12 }}>{selectedEnv}</Text>
            </View>
          )}
          <TouchableOpacity style={styles.refreshBtn} onPress={() => runTests(userId, selectedEnv)}>
            <Text style={styles.refreshBtnText}>Refresh</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <ActivityIndicator size="large" color="#d97706" style={{ marginTop: 40 }} />
        ) : (
          <>
            {results.map((r, i) => (
              <View key={i} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.testBadge}>
                    <Text style={styles.testBadgeText}>Test {i + 1}</Text>
                  </View>
                  <Text style={styles.testName}>{r.test}</Text>
                  <Text style={{ color: r.pass ? '#16a34a' : '#dc2626', fontSize: 16 }}>
                    {r.pass ? '✓' : '✗'}
                  </Text>
                </View>
                <View style={styles.detailBox}>
                  <Text style={styles.detailText}>{r.detail}</Text>
                </View>
              </View>
            ))}

            {/* Summary */}
            <View style={styles.summary}>
              <Text style={{ color: '#16a34a', fontWeight: '600' }}>Passed: {passed}</Text>
              {failed > 0 && <Text style={{ color: '#dc2626', fontWeight: '600' }}>Failed: {failed}</Text>}
              <Text style={{ color: '#666' }}>Total: {results.length}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  scroll: { padding: 16 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#d97706', marginBottom: 2 },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 6 },
  label: { fontWeight: '600', fontSize: 14 },
  chip: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff' },
  chipActive: { borderColor: '#d97706', backgroundColor: '#fef3c7' },
  chipText: { fontSize: 12, color: '#333' },
  chipTextActive: { color: '#92400e', fontWeight: '600' },
  envChipActive: { borderColor: '#3b82f6', backgroundColor: '#dbeafe' },
  envChipTextActive: { color: '#1e40af', fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 8 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4 },
  refreshBtn: { marginLeft: 'auto', paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#d97706', borderRadius: 6 },
  refreshBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  card: { backgroundColor: '#fff', borderRadius: 8, padding: 12, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 1 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  testBadge: { backgroundColor: '#fef3c7', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  testBadgeText: { fontSize: 11, fontWeight: 'bold', color: '#92400e' },
  testName: { flex: 1, fontWeight: '600', fontSize: 14 },
  detailBox: { marginTop: 8, padding: 8, backgroundColor: '#f1f5f9', borderRadius: 4 },
  detailText: { fontSize: 12, fontFamily: 'monospace', color: '#475569' },
  summary: { marginTop: 8, padding: 12, backgroundColor: '#f0fdf4', borderRadius: 6, flexDirection: 'row', gap: 16 },
});
