/**
 * SERVER-ONLY MODULE (PHASE P1.0, P1.1, P1.2)
 * Never imported by any browser/client module (enforced by client-bundle-guard.test.ts and check:bundle).
 * Never logs, prints, or returns raw secret values — booleans and lengths only.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import {
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  runTransaction,
  terminate
} from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

export const DEDICATED_SERVER_UID = 'uPep4vuatUOTt5qPDtYdcYVDccO2';

export interface FirebaseAppletConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

export interface P1EnvAndConfigReport {
  FIREBASE_SERVER_EMAIL_SET: boolean;
  FIREBASE_SERVER_EMAIL_LENGTH: number;
  FIREBASE_SERVER_EMAIL_VALID_FORMAT: boolean;
  FIREBASE_SERVER_PASSWORD_SET: boolean;
  FIREBASE_SERVER_PASSWORD_LENGTH: number;
  ADMIN_TOKEN_SET: boolean;
  ADMIN_TOKEN_LENGTH: number;
  ADMIN_TOKEN_LENGTH_GE_32: boolean;
  VISITOR_ID_SALT_SET: boolean;
  VISITOR_ID_SALT_LENGTH: number;
  VISITOR_ID_SALT_LENGTH_GE_32: boolean;
  firebasePackageInstalled: boolean;
  firebasePackageVersion: string | null;
  configFileExists: boolean;
  projectId: string | null;
  databaseConfigType: 'default' | 'named' | 'missing';
  firestoreEditionInfo: {
    detectedFromConsoleAndBillingUnits: string;
    sdkCompatibilityNote: string;
  };
  missingBlockingItems: string[];
}

export function loadFirebaseAppletConfig(): FirebaseAppletConfig | null {
  const cfgPath = path.resolve(ROOT_DIR, 'firebase-applet-config.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return JSON.parse(raw) as FirebaseAppletConfig;
  } catch {
    return null;
  }
}

export function getP1EnvAndConfigCheck(
  env: Record<string, string | undefined> = process.env
): P1EnvAndConfigReport {
  const email = (env.FIREBASE_SERVER_EMAIL ?? '').trim();
  const password = (env.FIREBASE_SERVER_PASSWORD ?? '').trim();
  const adminToken = (env.ADMIN_TOKEN ?? '').trim();
  const salt = (env.VISITOR_ID_SALT ?? '').trim();

  let fbVersion: string | null = null;
  try {
    const pkgPath = path.resolve(ROOT_DIR, 'node_modules/firebase/package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      fbVersion = pkg.version || null;
    }
  } catch {
    fbVersion = null;
  }

  const cfg = loadFirebaseAppletConfig();
  const dbId = (cfg?.firestoreDatabaseId ?? '').trim();
  const databaseConfigType: 'default' | 'named' | 'missing' = !cfg
    ? 'missing'
    : !dbId || dbId === '(default)'
      ? 'default'
      : 'named';

  const emailValidFormat = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const missing: string[] = [];
  if (!email) missing.push('FIREBASE_SERVER_EMAIL');
  else if (!emailValidFormat) {
    missing.push(
      `FIREBASE_SERVER_EMAIL is set (length ${email.length}) but does not match an email address format (contains "@": ${email.includes('@')}, contains ".": ${email.includes('.')})`
    );
  }
  if (!password) missing.push('FIREBASE_SERVER_PASSWORD');
  if (adminToken.length < 32) missing.push('ADMIN_TOKEN (>=32 chars)');
  if (salt.length < 32) missing.push('VISITOR_ID_SALT (>=32 chars)');
  if (!fbVersion) missing.push('firebase npm package');
  if (!cfg) missing.push('firebase-applet-config.json');

  return {
    FIREBASE_SERVER_EMAIL_SET: email.length > 0,
    FIREBASE_SERVER_EMAIL_LENGTH: email.length,
    FIREBASE_SERVER_EMAIL_VALID_FORMAT: emailValidFormat,
    FIREBASE_SERVER_PASSWORD_SET: password.length > 0,
    FIREBASE_SERVER_PASSWORD_LENGTH: password.length,
    ADMIN_TOKEN_SET: adminToken.length > 0,
    ADMIN_TOKEN_LENGTH: adminToken.length,
    ADMIN_TOKEN_LENGTH_GE_32: adminToken.length >= 32,
    VISITOR_ID_SALT_SET: salt.length > 0,
    VISITOR_ID_SALT_LENGTH: salt.length,
    VISITOR_ID_SALT_LENGTH_GE_32: salt.length >= 32,
    firebasePackageInstalled: Boolean(fbVersion),
    firebasePackageVersion: fbVersion,
    configFileExists: Boolean(cfg),
    projectId: cfg?.projectId ?? null,
    databaseConfigType,
    firestoreEditionInfo: {
      detectedFromConsoleAndBillingUnits:
        'Firestore Enterprise edition (indicated by read units / write units metering in the console; Standard edition meters document reads/writes/deletes).',
      sdkCompatibilityNote:
        'In Firestore Native mode (both Standard and Enterprise editions), the Firebase JS SDK (firebase/firestore: getFirestore(app, databaseId), doc, getDoc, setDoc, deleteDoc, runTransaction) uses the identical Native Firestore gRPC/REST wire protocol. Enterprise edition also adds optional pipeline/MongoDB compatibility APIs, which we do not use.'
    },
    missingBlockingItems: missing
  };
}

export interface P1AttemptOutcome {
  authOk: boolean;
  signedInUidMatchesServerUid: boolean;
  signedInUid: string | null;
  writeOk: boolean;
  readOk: boolean;
  transactionOk: boolean;
  deleteOk: boolean;
  allPassed: boolean;
  failedStep: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface P1ProbeResult extends P1AttemptOutcome {
  configType: 'default' | 'named' | 'missing';
  unauthenticatedDenied: boolean;
  unauthenticatedErrorCode: string | null;
  unauthenticatedError: string | null;
}

async function executeAuthenticatedProbe(
  cfg: FirebaseAppletConfig,
  dbId: string,
  emailToUse: string,
  passwordToUse: string
): Promise<P1AttemptOutcome> {
  const outcome: P1AttemptOutcome = {
    authOk: false,
    signedInUidMatchesServerUid: false,
    signedInUid: null,
    writeOk: false,
    readOk: false,
    transactionOk: false,
    deleteOk: false,
    allPassed: false,
    failedStep: null,
    errorCode: null,
    errorMessage: null
  };

  let serverApp: FirebaseApp | null = null;
  try {
    serverApp = initializeApp(
      {
        apiKey: cfg.apiKey,
        authDomain: cfg.authDomain,
        projectId: cfg.projectId,
        appId: cfg.appId
      },
      `p1-server-probe-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    );
    const auth = initializeAuth(serverApp, { persistence: inMemoryPersistence });
    const db = getFirestore(serverApp, dbId);

    try {
      // Step A: Sign in
      outcome.failedStep = 'sign_in';
      const cred = await signInWithEmailAndPassword(auth, emailToUse, passwordToUse);
      outcome.authOk = true;
      outcome.signedInUid = cred.user.uid;
      outcome.signedInUidMatchesServerUid = cred.user.uid === DEDICATED_SERVER_UID;

      if (!outcome.signedInUidMatchesServerUid) {
        outcome.failedStep = 'uid_mismatch';
        outcome.errorMessage = `Signed-in UID (${cred.user.uid}) does not match DEDICATED_SERVER_UID (${DEDICATED_SERVER_UID})`;
        return outcome;
      }

      const probeId = `probe_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const probeRef = doc(db, '_server_probe', probeId);

      // Step B: Write throwaway document
      outcome.failedStep = 'write_doc';
      await setDoc(probeRef, {
        schemaVersion: 2,
        counter: 1,
        createdAtIso: new Date().toISOString()
      });
      outcome.writeOk = true;

      // Step C: Read throwaway document
      outcome.failedStep = 'read_doc';
      const snap = await getDoc(probeRef);
      if (!snap.exists() || snap.data()?.counter !== 1) {
        throw new Error('Throwaway document read did not match written payload');
      }
      outcome.readOk = true;

      // Step D: Run one transaction
      outcome.failedStep = 'transaction';
      const newCounter = await runTransaction(db, async tx => {
        const txSnap = await tx.get(probeRef);
        if (!txSnap.exists()) {
          throw new Error('Document missing inside transaction');
        }
        const nextVal = Number(txSnap.data()?.counter ?? 0) + 1;
        tx.update(probeRef, { counter: nextVal });
        return nextVal;
      });
      if (newCounter !== 2) {
        throw new Error(`Expected transaction counter=2, got ${newCounter}`);
      }
      outcome.transactionOk = true;

      // Step E: Delete throwaway document
      outcome.failedStep = 'delete_doc';
      await deleteDoc(probeRef);
      const afterDelete = await getDoc(probeRef);
      if (afterDelete.exists()) {
        throw new Error('Document still existed after deleteDoc');
      }
      outcome.deleteOk = true;

      outcome.failedStep = null;
      outcome.allPassed =
        outcome.authOk &&
        outcome.signedInUidMatchesServerUid &&
        outcome.writeOk &&
        outcome.readOk &&
        outcome.transactionOk &&
        outcome.deleteOk;
    } catch (err: any) {
      outcome.errorCode = err?.code ? String(err.code) : null;
      outcome.errorMessage = err?.message ? String(err.message) : String(err);
    } finally {
      await signOut(auth).catch(() => {});
      await terminate(db).catch(() => {});
    }
  } finally {
    if (serverApp) {
      await deleteApp(serverApp).catch(() => {});
    }
  }

  return outcome;
}

export async function runFirestoreServerProbe(
  env: Record<string, string | undefined> = process.env
): Promise<P1ProbeResult> {
  const cfg = loadFirebaseAppletConfig();
  const email = (env.FIREBASE_SERVER_EMAIL ?? '').trim();
  const password = (env.FIREBASE_SERVER_PASSWORD ?? '').trim();

  const result: P1ProbeResult = {
    configType: !cfg
      ? 'missing'
      : !cfg.firestoreDatabaseId || cfg.firestoreDatabaseId === '(default)'
        ? 'default'
        : 'named',
    unauthenticatedDenied: false,
    unauthenticatedErrorCode: null,
    unauthenticatedError: null,
    authOk: false,
    signedInUidMatchesServerUid: false,
    signedInUid: null,
    writeOk: false,
    readOk: false,
    transactionOk: false,
    deleteOk: false,
    allPassed: false,
    failedStep: null,
    errorCode: null,
    errorMessage: null
  };

  if (!cfg) {
    result.failedStep = 'load_config';
    result.errorMessage = 'firebase-applet-config.json not found';
    return result;
  }

  const dbId =
    cfg.firestoreDatabaseId && cfg.firestoreDatabaseId.trim().length > 0
      ? cfg.firestoreDatabaseId.trim()
      : '(default)';

  // 1. P1.2 Check: Prove that an UNAUTHENTICATED request is denied by firestore.rules
  let unauthApp: FirebaseApp | null = null;
  try {
    unauthApp = initializeApp(
      {
        apiKey: cfg.apiKey,
        authDomain: cfg.authDomain,
        projectId: cfg.projectId,
        appId: cfg.appId
      },
      `p1-unauth-probe-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    );
    initializeAuth(unauthApp, { persistence: inMemoryPersistence });
    const unauthDb = getFirestore(unauthApp, dbId);
    try {
      await getDoc(doc(unauthDb, '_server_probe', 'unauth_check'));
      result.unauthenticatedDenied = false;
      result.unauthenticatedError = 'Unexpectedly allowed unauthenticated read';
    } catch (unauthErr: any) {
      const code = String(unauthErr?.code || '');
      const msg = String(unauthErr?.message || unauthErr);
      result.unauthenticatedErrorCode = code || null;
      result.unauthenticatedError = msg;
      if (
        code.includes('permission-denied') ||
        msg.includes('Missing or insufficient permissions') ||
        msg.includes('PERMISSION_DENIED')
      ) {
        result.unauthenticatedDenied = true;
      }
    } finally {
      await terminate(unauthDb).catch(() => {});
    }
  } finally {
    if (unauthApp) {
      await deleteApp(unauthApp).catch(() => {});
    }
  }

  // 2. P1.1 Check: Authenticate as dedicated server user (inMemoryPersistence)
  if (!email || !password) {
    result.failedStep = 'missing_credentials';
    result.errorMessage = 'FIREBASE_SERVER_EMAIL or FIREBASE_SERVER_PASSWORD is empty';
    return result;
  }

  const directOutcome = await executeAuthenticatedProbe(cfg, dbId, email, password);
  Object.assign(result, directOutcome, {
    allPassed: result.unauthenticatedDenied && directOutcome.allPassed
  });

  return result;
}

/**
 * P2c.1: Firestore Transaction helper for Single-Flight Scan Deduplication.
 * Uses deterministic document ID `active_${visitorHash}_${domain}` inside `runTransaction`:
 * - If an active ('queued' | 'running') marker exists and has not expired (SCAN_TIMEOUT_S + 30s),
 *   returns { reused: true, scanId } without consuming quota.
 * - Otherwise writes the active marker atomically within the same transaction.
 */
export async function reserveSingleFlightInFirestoreTransaction(
  db: ReturnType<typeof getFirestore>,
  params: {
    visitorHash: string;
    registrableDomain: string;
    scanId: string;
    ttlMs: number;
    nowMs?: number;
  }
): Promise<{ reused: boolean; scanId: string }> {
  const now = params.nowMs ?? Date.now();
  const cleanDomain = params.registrableDomain.trim().toLowerCase();
  const markerId = `active_${params.visitorHash}_${cleanDomain}`;
  const markerRef = doc(db, 'quotas', markerId);

  return runTransaction(db, async tx => {
    const snap = await tx.get(markerRef);
    if (snap.exists()) {
      const data = snap.data();
      const status = data?.status;
      const expiresAtMs = Number(data?.expiresAtMs ?? 0);
      const existingScanId = String(data?.scanId ?? '');
      if (
        existingScanId &&
        (status === 'queued' || status === 'running') &&
        now < expiresAtMs
      ) {
        return { reused: true, scanId: existingScanId };
      }
    }

    const expiresAtMs = now + params.ttlMs;
    tx.set(markerRef, {
      schemaVersion: 2,
      markerId,
      visitorIdHash: params.visitorHash,
      registrableDomain: cleanDomain,
      scanId: params.scanId,
      status: 'queued',
      createdAtMs: now,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString()
    });
    return { reused: false, scanId: params.scanId };
  });
}

