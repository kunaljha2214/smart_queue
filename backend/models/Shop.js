const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  duration: { type: Number, required: true },
  price: { type: Number, required: true }
});

const shopSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  address: {
    type: String,
    required: true,
    trim: true
  },
  lat: {
    type: Number,
    required: true
  },
  lng: {
    type: Number,
    required: true
  },
  services: [serviceSchema],
  subscription: {
    isActive: {
      type: Boolean,
      default: false
    },
    monthlyCharge: {
      type: Number,
      default: 300
    },
    lastPaidAt: {
      type: Date,
      default: null
    },
    nextDueAt: {
      type: Date,
      default: null
    },
    lastPaymentId: {
      type: String,
      default: null
    },
    lastPaymentStatus: {
      type: String,
      default: null
    },
    pendingPaymentLinkId: {
      type: String,
      default: null
    },
    pendingPaymentLinkUrl: {
      type: String,
      default: null
    }
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Shop', shopSchema);