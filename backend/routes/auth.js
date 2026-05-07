const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const User = require('../models/User');
const SignupOtp = require('../models/SignupOtp');
const { protect } = require('../middleware/auth');
const { getFcmInitStatus, sendFcmDataAndNotification } = require('../services/fcm');

const router = express.Router();

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const isBrevoConfigured = () => Boolean(process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL);
const hasAnyBrevoConfig = () =>
  Boolean(process.env.BREVO_API_KEY || process.env.BREVO_FROM_EMAIL || process.env.BREVO_FROM_NAME);
const isSmtpConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);

const SMTP_SEND_MS = 60000;

const createTransporter = () =>
  nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  });

const sendOtpEmail = async ({ to, otp }) => {
  if (isBrevoConfigured()) {
    const fromName = process.env.BREVO_FROM_NAME || 'Smart Queue';
    const body = {
      sender: {
        name: fromName,
        email: process.env.BREVO_FROM_EMAIL,
      },
      to: [{ email: to }],
      subject: 'Smart Queue OTP Verification',
      textContent: `Your Smart Queue OTP is ${otp}. It expires in 10 minutes.`,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5;">
          <h2>Smart Queue Verification</h2>
          <p>Your OTP is:</p>
          <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px;">${otp}</p>
          <p>This OTP expires in <strong>10 minutes</strong>.</p>
        </div>
      `,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SMTP_SEND_MS);
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'api-key': process.env.BREVO_API_KEY,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        let details = '';
        try {
          details = await res.text();
        } catch {
          details = '';
        }
        throw new Error(`Brevo API failed (${res.status})${details ? `: ${details}` : ''}`);
      }
      return;
    } finally {
      clearTimeout(timer);
    }
  }

  const transporter = createTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const mailOptions = {
    from,
    to,
    subject: 'Smart Queue OTP Verification',
    text: `Your Smart Queue OTP is ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2>Smart Queue Verification</h2>
        <p>Your OTP is:</p>
        <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px;">${otp}</p>
        <p>This OTP expires in <strong>10 minutes</strong>.</p>
      </div>
    `,
  };

  const sendPromise = transporter.sendMail(mailOptions);
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('SMTP send timed out — check SMTP host, port, and firewall.')),
      SMTP_SEND_MS
    );
  });
  try {
    await Promise.race([sendPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const generateSignupVerificationToken = (email) =>
  jwt.sign({ email: email.toLowerCase().trim(), scope: 'signup' }, process.env.JWT_SECRET, {
    expiresIn: '30m',
  });

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, role, emailVerificationToken } = req.body;

    if (!emailVerificationToken) {
      return res.status(400).json({
        message: 'Email verification required. Verify your email with OTP before creating an account.',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(emailVerificationToken, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({
        message: 'Invalid or expired email verification. Request a new OTP from the signup screen.',
      });
    }

    if (decoded.scope !== 'signup' || decoded.email !== String(email).toLowerCase().trim()) {
      return res.status(400).json({ message: 'Email verification does not match this signup.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const user = await User.create({ name, email, password, phone, role: role || 'user' });
    const token = generateToken(user._id);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = generateToken(user._id);

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/otp/send', async (req, res) => {
  try {
    const { email, purpose } = req.body;
    const normalizedEmail = String(email || '')
      .toLowerCase()
      .trim();

    if (!normalizedEmail) {
      return res.status(400).json({ message: 'Email is required' });
    }

    if (mongoose.connection.readyState !== 1) {
      console.error('[otp/send] MongoDB not connected, readyState=', mongoose.connection.readyState);
      return res.status(503).json({
        message: 'Database is not ready. Wait a few seconds and try again.',
      });
    }

    if (hasAnyBrevoConfig() && !isBrevoConfigured()) {
      return res.status(500).json({
        message:
          'Partial Brevo config detected. Please set both BREVO_API_KEY and BREVO_FROM_EMAIL, then redeploy.',
      });
    }

    if (!isBrevoConfigured() && !isSmtpConfigured()) {
      return res.status(500).json({
        message:
          'Email service is not configured. Set BREVO_API_KEY + BREVO_FROM_EMAIL or SMTP variables.',
      });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const provider = isBrevoConfigured() ? 'brevo_api' : 'smtp';

    const isSignup = purpose === 'signup';
    console.log(
      '[otp/send] email=%s purpose=%s (signup=%s) provider=%s',
      normalizedEmail,
      purpose || 'existing',
      isSignup,
      provider
    );

    if (isSignup) {
      const existingUser = await User.findOne({ email: normalizedEmail });
      if (existingUser) {
        return res.status(400).json({ message: 'An account with this email already exists. Sign in instead.' });
      }

      await SignupOtp.findOneAndUpdate(
        { email: normalizedEmail },
        { email: normalizedEmail, code: otp, expiresAt },
        { upsert: true, new: true }
      );
    } else {
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      user.otp = { code: otp, expiresAt };
      await user.save();
    }

    await sendOtpEmail({ to: normalizedEmail, otp });

    console.log('[otp/send] sent ok email=%s purpose=%s', normalizedEmail, purpose || 'existing');

    res.json({
      message: 'OTP sent successfully to your email',
      expiresIn: 600,
    });
  } catch (error) {
    const msg = String(error?.message || 'Failed to send OTP email');
    const code = String(error?.code || '');
    console.error('[otp/send] error:', msg, code ? `(code=${code})` : '');

    const lowered = msg.toLowerCase();
    const smtpLikeError =
      code === 'ETIMEDOUT' ||
      code === 'ECONNECTION' ||
      code === 'EAUTH' ||
      lowered.includes('smtp') ||
      lowered.includes('brevo') ||
      lowered.includes('timed out') ||
      lowered.includes('connection');

    if (smtpLikeError) {
      return res.status(502).json({
        message:
          'Email provider is temporarily unavailable. Please try again in a minute. If it continues, verify SMTP credentials and app password.',
      });
    }

    res.status(500).json({ message: msg });
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const { email, otp, purpose } = req.body;
    const normalizedEmail = String(email || '')
      .toLowerCase()
      .trim();

    console.log('[otp/verify] email=%s purpose=%s', normalizedEmail, purpose || 'existing');

    if (purpose === 'signup') {
      const row = await SignupOtp.findOne({ email: normalizedEmail });
      if (!row || !row.code) {
        return res.status(400).json({ message: 'No OTP requested for this email' });
      }
      if (new Date() > row.expiresAt) {
        await SignupOtp.deleteOne({ email: normalizedEmail });
        return res.status(400).json({ message: 'OTP expired' });
      }
      if (row.code !== otp) {
        return res.status(400).json({ message: 'Invalid OTP' });
      }

      await SignupOtp.deleteOne({ email: normalizedEmail });

      const emailVerificationToken = generateSignupVerificationToken(normalizedEmail);

      return res.json({
        message: 'Email verified. You can create your account.',
        emailVerificationToken,
      });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.otp || !user.otp.code) {
      return res.status(400).json({ message: 'No OTP requested' });
    }

    if (new Date() > user.otp.expiresAt) {
      return res.status(400).json({ message: 'OTP expired' });
    }

    if (user.otp.code !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    user.otp = undefined;
    await user.save();

    const token = generateToken(user._id);

    res.json({
      message: 'OTP verified successfully',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/push/register', protect, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ message: 'Push token is required' });
    }
    if (!token.startsWith('ExponentPushToken[')) {
      return res.status(400).json({ message: 'Invalid Expo push token format' });
    }

    await User.updateOne(
      { _id: req.user._id },
      { $addToSet: { expoPushTokens: token } }
    );
    return res.json({ message: 'Push token saved' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/push/unregister', protect, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ message: 'Push token is required' });
    }
    await User.updateOne(
      { _id: req.user._id },
      { $pull: { expoPushTokens: token } }
    );
    return res.json({ message: 'Push token removed' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

/** FCM device token (Android). Customers and owners — join alerts, turn-soon, etc. */
router.post('/fcm/register', protect, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token || token.length < 32) {
      return res.status(400).json({ message: 'Valid FCM device token is required' });
    }
    await User.updateOne({ _id: req.user._id }, { $addToSet: { fcmTokens: token } });
    return res.json({ message: 'FCM token saved' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/fcm/unregister', protect, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ message: 'FCM token is required' });
    }
    await User.updateOne({ _id: req.user._id }, { $pull: { fcmTokens: token } });
    return res.json({ message: 'FCM token removed' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

/** Debug: verify Firebase Admin init + token count for current user */
router.get('/fcm/status', protect, async (req, res) => {
  try {
    const status = getFcmInitStatus();
    const user = await User.findById(req.user._id).select('email role fcmTokens expoPushTokens');
    return res.json({
      firebase: status,
      user: {
        id: String(req.user._id),
        email: user?.email,
        role: user?.role,
        fcmTokenCount: Array.isArray(user?.fcmTokens) ? user.fcmTokens.length : 0,
        expoTokenCount: Array.isArray(user?.expoPushTokens) ? user.expoPushTokens.length : 0,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

/** Debug: send a test push to the logged-in user via FCM */
router.post('/fcm/test', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('fcmTokens');
    const tokens = (user?.fcmTokens || []).map((t) => String(t).trim()).filter(Boolean);
    if (!tokens.length) {
      return res.status(400).json({ message: 'No fcmTokens saved for this user yet' });
    }
    const title = 'Smart Queue FCM test';
    const body = `Hello ${req.user?.name || ''}`.trim() || 'Hello';
    const result = await sendFcmDataAndNotification(tokens, {
      title,
      body,
      data: { type: 'fcm_test', t: String(Date.now()) },
    });
    return res.json({ message: 'Sent', result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;