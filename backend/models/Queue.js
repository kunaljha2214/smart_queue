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
    required: true
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