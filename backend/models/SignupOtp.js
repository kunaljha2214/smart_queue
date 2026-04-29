const mongoose = require('mongoose');

const signupOtpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    unique: true,
  },
  code: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});

module.exports = mongoose.model('SignupOtp', signupOtpSchema);
