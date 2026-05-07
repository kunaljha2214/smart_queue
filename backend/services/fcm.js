const admin = require('firebase-admin');

let app;

const initFirebaseAdmin = () => {
  if (app) return app;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (raw) {
      const cred = JSON.parse(raw);
      app = admin.initializeApp({ credential: admin.credential.cert(cred) });
      return app;
    }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      app = admin.initializeApp({ credential: admin.credential.applicationDefault() });
      return app;
    }
  } catch (e) {
    console.error('[fcm] Firebase Admin init failed:', e.message);
  }
  return null;
};

const getMessaging = () => {
  if (!initFirebaseAdmin()) return null;
  return admin.messaging();
};

const getFcmInitStatus = () => {
  const hasServiceAccountEnv = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const hasGoogleAppCreds = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const initialized = Boolean(initFirebaseAdmin());
  return { initialized, hasServiceAccountEnv, hasGoogleAppCreds };
};

/**
 * @param {string[]} tokens
 * @param {{ title: string, body: string, data?: Record<string, string> }} payload
 */
const sendFcmDataAndNotification = async (tokens, { title, body, data = {} }) => {
  const messaging = getMessaging();
  if (!messaging || !Array.isArray(tokens) || !tokens.length) {
    return { successCount: 0, failureCount: 0, initialized: Boolean(messaging) };
  }

  const dataPayload = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    dataPayload[String(k)] = String(v);
  }

  const messages = tokens.map((token) => ({
    token,
    notification: { title, body },
    data: dataPayload,
    android: { priority: 'high' },
  }));

  try {
    const result = await messaging.sendEach(messages);
    if (result.failureCount > 0) {
      console.warn('[fcm] partial failure', result.failureCount, '/', messages.length);
    }
    return {
      successCount: result.successCount,
      failureCount: result.failureCount,
      initialized: true,
      responses: result.responses?.map((r) => ({
        success: Boolean(r.success),
        error: r.error ? String(r.error.message || r.error) : null,
      })),
    };
  } catch (e) {
    console.error('[fcm] sendEach failed:', e.message);
    return {
      successCount: 0,
      failureCount: messages.length,
      initialized: true,
      error: String(e.message || e),
    };
  }
};

module.exports = { sendFcmDataAndNotification, getMessaging, getFcmInitStatus };
