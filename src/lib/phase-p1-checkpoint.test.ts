import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isForbiddenClientSpecifier, scanClientImportGraph } from './client-bundle-guard.test';
import { getP1EnvAndConfigCheck, runFirestoreServerProbe } from './firestore-probe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

test('P1.0: getP1EnvAndConfigCheck reports booleans and lengths only (no secret values)', () => {
  const status = getP1EnvAndConfigCheck();
  assert.equal(typeof status.FIREBASE_SERVER_EMAIL_SET, 'boolean');
  assert.equal(typeof status.FIREBASE_SERVER_PASSWORD_SET, 'boolean');
  assert.equal(typeof status.ADMIN_TOKEN_SET, 'boolean');
  assert.equal(typeof status.ADMIN_TOKEN_LENGTH_GE_32, 'boolean');
  assert.equal(typeof status.VISITOR_ID_SALT_SET, 'boolean');
  assert.equal(typeof status.VISITOR_ID_SALT_LENGTH_GE_32, 'boolean');
  assert.equal(typeof status.firebasePackageInstalled, 'boolean');
  assert.ok(status.firebasePackageVersion && status.firebasePackageVersion.length > 0);
  assert.equal(status.databaseConfigType, 'named');

  // Verify no actual secret string appears in the serialized status object
  const serialized = JSON.stringify(status);
  const email = (process.env.FIREBASE_SERVER_EMAIL || '').trim();
  const pass = (process.env.FIREBASE_SERVER_PASSWORD || '').trim();
  const adminToken = (process.env.ADMIN_TOKEN || '').trim();
  const salt = (process.env.VISITOR_ID_SALT || '').trim();
  if (email.length > 4) assert.ok(!serialized.includes(email), 'Must never include FIREBASE_SERVER_EMAIL value');
  if (pass.length > 4) assert.ok(!serialized.includes(pass), 'Must never include FIREBASE_SERVER_PASSWORD value');
  if (adminToken.length > 4) assert.ok(!serialized.includes(adminToken), 'Must never include ADMIN_TOKEN value');
  if (salt.length > 4) assert.ok(!serialized.includes(salt), 'Must never include VISITOR_ID_SALT value');
});

test('P1.1: Client bundle guard rejects firebase, firebase/*, and firebase-applet-config.json in browser graph', () => {
  assert.equal(isForbiddenClientSpecifier('firebase'), true);
  assert.equal(isForbiddenClientSpecifier('firebase/app'), true);
  assert.equal(isForbiddenClientSpecifier('firebase/auth'), true);
  assert.equal(isForbiddenClientSpecifier('firebase/firestore'), true);
  assert.equal(isForbiddenClientSpecifier('../firebase-applet-config.json'), true);

  const entry = path.resolve(ROOT_DIR, 'src/main.tsx');
  const { violations } = scanClientImportGraph(entry);
  assert.deepEqual(violations, []);
});

test('P1.1 & P1.2: Server-only Firestore probe and unauthenticated denial check', async () => {
  const rulesRaw = fs.readFileSync(path.resolve(ROOT_DIR, 'firestore.rules'), 'utf8');
  assert.ok(
    rulesRaw.includes("request.auth.uid == 'uPep4vuatUOTt5qPDtYdcYVDccO2'"),
    'firestore.rules must restrict access to dedicated SERVER_UID'
  );
  assert.ok(
    rulesRaw.includes("request.auth.token.firebase.sign_in_provider == 'password'"),
    'firestore.rules must require password sign_in_provider'
  );

  const probe = await runFirestoreServerProbe();
  assert.equal(typeof probe.unauthenticatedDenied, 'boolean');
  assert.equal(probe.unauthenticatedDenied, true, `Unauthenticated request must be denied, got: ${probe.unauthenticatedError || 'allowed'}`);
  assert.equal(typeof probe.authOk, 'boolean');
  assert.equal(typeof probe.writeOk, 'boolean');
  assert.equal(typeof probe.readOk, 'boolean');
  assert.equal(typeof probe.transactionOk, 'boolean');
  assert.equal(typeof probe.deleteOk, 'boolean');
});
