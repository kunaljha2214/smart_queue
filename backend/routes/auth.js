const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const User = require('../models/User');
const SignupOtp = require('../models/SignupOtp');

const router = express.Router();

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const isSmtpConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);

const createTransporter = () =>
  nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

const sendOtpEmail = async ({ to, otp }) => {
  const transporter = createTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({
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
  });
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

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    if (purpose === 'signup') {
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

    if (!isSmtpConfigured()) {
      return res.status(500).json({
        message: 'Email service is not configured. Please set SMTP env variables.',
      });
    }

    await sendOtpEmail({ to: normalizedEmail, otp });

    res.json({
      message: 'OTP sent successfully to your email',
      expiresIn: 600,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const { email, otp, purpose } = req.body;
    const normalizedEmail = String(email || '')
      .toLowerCase()
      .trim();

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

module.exports = router;