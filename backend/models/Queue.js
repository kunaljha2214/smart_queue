const mongoose = require('mongoose');

const queueSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  /** In-shop customers not using the app; no user account. */
  isWalkIn: {
    type: Boolean,
    default: false,
  },
  /** Stable display ID for walk-ins only (e.g. W-12); assigned by backend. */
  walkInRef: {
    type: String,
    default: null,
  },
  service: {
    name: { type: String, required: true },
    duration: { type: Number, required: true }
  },
  position: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['waiting', 'serving', 'done', 'cancelled'],
    default: 'waiting'
  },
  estimatedWait: {
    type: Number,
    default: 0
  },
  turnSoonNotifiedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

queueSchema.index({ shopId: 1, status: 1 });

module.exports = mongoose.model('Queue', queueSchema);