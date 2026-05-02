const express = require('express');
const Ads = require('../models/Ads');
const { protect, ownerOnly } = require('../middleware/auth');

const router = express.Router();

/** List all ad unit configs */
router.get('/', async (req, res) => {
  try {
    const ads = await Ads.find().sort({ typeName: 1 });
    res.json(ads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/** Get one by id */
router.get('/:id', async (req, res) => {
  try {
    const doc = await Ads.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ message: 'Ad config not found' });
    }
    res.json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/** Create */
router.post('/', protect, ownerOnly, async (req, res) => {
  try {
    const { typeName, adId } = req.body;
    if (!typeName || !adId) {
      return res.status(400).json({ message: 'typeName and adId are required' });
    }
    const doc = await Ads.create({
      typeName: String(typeName).trim(),
      adId: String(adId).trim(),
    });
    res.status(201).json(doc);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'typeName already exists' });
    }
    res.status(500).json({ message: error.message });
  }
});

/** Update */
router.put('/:id', protect, ownerOnly, async (req, res) => {
  try {
    const { typeName, adId } = req.body;
    const doc = await Ads.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ message: 'Ad config not found' });
    }
    if (typeName !== undefined) doc.typeName = String(typeName).trim();
    if (adId !== undefined) doc.adId = String(adId).trim();
    if (!doc.typeName || !doc.adId) {
      return res.status(400).json({ message: 'typeName and adId cannot be empty' });
    }
    await doc.save();
    res.json(doc);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'typeName already exists' });
    }
    res.status(500).json({ message: error.message });
  }
});

/** Delete */
router.delete('/:id', protect, ownerOnly, async (req, res) => {
  try {
    const doc = await Ads.findByIdAndDelete(req.params.id);
    if (!doc) {
      return res.status(404).json({ message: 'Ad config not found' });
    }
    res.json({ message: 'Deleted', id: doc._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
