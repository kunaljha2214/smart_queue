const mongoose = require('mongoose');

const adsSchema = new mongoose.Schema(
  {
    typeName: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    adId: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Ads', adsSchema);
